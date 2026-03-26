import type {
	NormalizedSessionSnapshot,
	PluginSettings,
	StabilityDecision,
	StabilityState,
} from "../types";

export class StabilityDetector {
	private readonly state = new Map<string, StabilityState>();

	accept(
		snapshot: NormalizedSessionSnapshot,
		settings: PluginSettings,
		options?: { force?: boolean },
	): StabilityDecision {
		if (options?.force) {
			this.state.delete(snapshot.sessionKey);
			return {
				readyToPersist: true,
				reason: "forced",
				snapshot,
			};
		}

		const lastMessage = snapshot.messages.at(-1);
		if (!lastMessage) {
			return {
				readyToPersist: false,
				reason: "empty-snapshot",
				snapshot,
			};
		}

		if (lastMessage.role !== "assistant") {
			this.state.delete(snapshot.sessionKey);
			return {
				readyToPersist: true,
				reason: "last-message-not-assistant",
				snapshot,
			};
		}

		if (lastMessage.hasCompletionActions) {
			this.state.delete(snapshot.sessionKey);
			return {
				readyToPersist: true,
				reason: "assistant-completion-actions-visible",
				snapshot,
			};
		}

		const currentState = this.state.get(snapshot.sessionKey) ?? {
			sessionKey: snapshot.sessionKey,
			stableRepeatCount: 0,
		};

		if (currentState.lastAssistantUid !== lastMessage.uid) {
			this.state.set(snapshot.sessionKey, {
				sessionKey: snapshot.sessionKey,
				lastAssistantUid: lastMessage.uid,
				firstSeenAt: snapshot.capturedAt,
				lastHash: lastMessage.textHash,
				stableRepeatCount: 0,
			});
			return {
				readyToPersist: false,
				reason: "assistant-message-started",
				snapshot,
			};
		}

		const sameHash = currentState.lastHash === lastMessage.textHash;
		const nextState: StabilityState = {
			sessionKey: snapshot.sessionKey,
			lastAssistantUid: lastMessage.uid,
			firstSeenAt: currentState.firstSeenAt ?? snapshot.capturedAt,
			lastHash: lastMessage.textHash,
			stableRepeatCount: sameHash ? currentState.stableRepeatCount + 1 : 0,
		};
		this.state.set(snapshot.sessionKey, nextState);

		const elapsedMs = snapshot.capturedAt - (nextState.firstSeenAt ?? snapshot.capturedAt);
		const ready =
			nextState.stableRepeatCount >= settings.settleRepeatCount ||
			(sameHash && elapsedMs >= settings.settleTimeoutMs);

		return {
			readyToPersist: ready,
			reason: ready ? "assistant-settled" : "assistant-streaming",
			snapshot,
		};
	}
}
