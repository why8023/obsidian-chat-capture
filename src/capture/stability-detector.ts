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

		if (lastMessage.role !== "ai") {
			this.state.delete(snapshot.sessionKey);
			return {
				readyToPersist: true,
				reason: "last-message-not-ai",
				snapshot,
			};
		}

		if (lastMessage.hasCompletionActions) {
			this.state.delete(snapshot.sessionKey);
			return {
				readyToPersist: true,
				reason: "ai-completion-actions-visible",
				snapshot,
			};
		}

		const currentState = this.state.get(snapshot.sessionKey) ?? {
			sessionKey: snapshot.sessionKey,
			stableRepeatCount: 0,
		};

		if (currentState.lastAiUid !== lastMessage.uid) {
			this.state.set(snapshot.sessionKey, {
				sessionKey: snapshot.sessionKey,
				lastAiUid: lastMessage.uid,
				firstSeenAt: snapshot.capturedAt,
				lastHash: lastMessage.textHash,
				stableRepeatCount: 0,
			});
			return {
				readyToPersist: false,
				reason: "ai-message-started",
				snapshot,
			};
		}

		const sameHash = currentState.lastHash === lastMessage.textHash;
		const nextState: StabilityState = {
			sessionKey: snapshot.sessionKey,
			lastAiUid: lastMessage.uid,
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
			reason: ready ? "ai-settled" : "ai-streaming",
			snapshot,
		};
	}
}
