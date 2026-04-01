import { Notice } from "obsidian";
import { formatObarUiText } from "../constants";
import type {
	CaptureErrorResult,
	CaptureRunResult,
	CaptureSavedResult,
} from "../types";

export class CaptureNoticeManager {
	private errorNotice: Notice | null = null;

	handleCaptureResult(result: CaptureRunResult): void {
		if (result.status === "error") {
			this.showError(result);
			return;
		}

		this.clearError();
		if (result.status === "saved") {
			this.showSuccess(result);
		}
	}

	dispose(): void {
		this.clearError();
	}

	private showSuccess(result: CaptureSavedResult): void {
		const action = result.created ? "Synced" : "Updated";
		const suffix = result.partial ? " Partial capture." : "";
		new Notice(
			formatObarUiText(
				`${action} ${result.filePath} (${result.messageCount} messages).${suffix}`,
			),
		);
	}

	private showError(result: CaptureErrorResult): void {
		const namePrefix = result.error.name ? `${result.error.name}: ` : "";
		const message = formatObarUiText(
			`Capture failed during ${result.stage}: ${namePrefix}${result.error.message}`,
		);
		if (this.errorNotice) {
			this.errorNotice.setMessage(message);
			return;
		}

		this.errorNotice = new Notice(message, 0);
	}

	private clearError(): void {
		this.errorNotice?.hide();
		this.errorNotice = null;
	}
}
