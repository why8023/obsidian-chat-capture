import { App, type Command } from "obsidian";

export interface CommandManagerLike {
	commands?: Record<string, Command>;
	executeCommandById?: (
		commandId: string,
	) => boolean | void | Promise<boolean | void>;
}

type AppWithCommands = App & {
	commands?: CommandManagerLike;
};

export interface ObsidianCommandOption {
	id: string;
	name: string;
	searchText: string;
	command: Command;
}

export function getCommandManager(app: App): CommandManagerLike | undefined {
	return (app as AppWithCommands).commands;
}

export function listObsidianCommands(app: App): ObsidianCommandOption[] {
	const commands = Object.values(getCommandManager(app)?.commands ?? {});

	return commands
		.filter((command): command is Command => Boolean(command?.id))
		.map((command) => ({
			id: command.id,
			name: command.name?.trim() || command.id,
			searchText: `${command.name?.trim() || command.id} ${command.id}`,
			command,
		}))
		.sort((left, right) => {
			const byName = left.name.localeCompare(right.name);
			return byName !== 0 ? byName : left.id.localeCompare(right.id);
		});
}

export function getObsidianCommand(
	app: App,
	commandId: string,
): ObsidianCommandOption | null {
	return (
		listObsidianCommands(app).find((command) => command.id === commandId) ?? null
	);
}
