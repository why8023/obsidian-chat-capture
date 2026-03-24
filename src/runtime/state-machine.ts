import type { RuntimeState } from "../types";

const ALLOWED_TRANSITIONS: Record<RuntimeState, RuntimeState[]> = {
	idle: ["openingViewer", "bindingWebview", "injecting", "polling", "error"],
	openingViewer: ["bindingWebview", "backoff", "error"],
	bindingWebview: ["injecting", "polling", "backoff", "error"],
	injecting: ["polling", "backoff", "error"],
	polling: ["saving", "backoff", "error", "idle"],
	saving: ["polling", "backoff", "error", "idle"],
	backoff: ["bindingWebview", "injecting", "polling", "error", "idle"],
	error: ["idle", "bindingWebview", "injecting", "polling"],
};

export class RuntimeStateMachine {
	private currentState: RuntimeState = "idle";

	get state(): RuntimeState {
		return this.currentState;
	}

	transition(nextState: RuntimeState): boolean {
		if (this.currentState === nextState) {
			return true;
		}

		if (!ALLOWED_TRANSITIONS[this.currentState].includes(nextState)) {
			return false;
		}

		this.currentState = nextState;
		return true;
	}

	force(nextState: RuntimeState): void {
		this.currentState = nextState;
	}
}
