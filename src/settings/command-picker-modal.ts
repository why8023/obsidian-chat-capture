import { App, FuzzySuggestModal, type FuzzyMatch } from "obsidian";
import {
	listObsidianCommands,
	type ObsidianCommandOption,
} from "../commands/command-registry";
import { getSettingsTabCopy } from "./localization";

interface CommandPickerModalOptions {
	excludedCommandIds: string[];
	onChoose: (command: ObsidianCommandOption) => void;
}

export class CommandPickerModal extends FuzzySuggestModal<ObsidianCommandOption> {
	private readonly items: ObsidianCommandOption[];
	private readonly options: CommandPickerModalOptions;

	constructor(app: App, options: CommandPickerModalOptions) {
		super(app);
		this.options = options;
		this.items = listObsidianCommands(app).filter(
			(command) => !options.excludedCommandIds.includes(command.id),
		);

		const copy = getSettingsTabCopy();
		this.setPlaceholder(copy.commandPicker.placeholder);
		this.emptyStateText = copy.commandPicker.empty;
		this.setInstructions([
			{ command: "Enter", purpose: copy.commandPicker.chooseHint },
			{ command: "Esc", purpose: copy.commandPicker.dismissHint },
		]);
	}

	getItems(): ObsidianCommandOption[] {
		return this.items;
	}

	getItemText(item: ObsidianCommandOption): string {
		return item.searchText;
	}

	renderSuggestion(match: FuzzyMatch<ObsidianCommandOption>, el: HTMLElement): void {
		const { item } = match;
		el.createDiv({
			cls: "obar-command-suggestion-name",
			text: item.name,
		});
		el.createDiv({
			cls: "obar-command-suggestion-id",
			text: item.id,
		});
	}

	onChooseItem(item: ObsidianCommandOption, _evt: MouseEvent | KeyboardEvent): void {
		this.options.onChoose(item);
	}
}
