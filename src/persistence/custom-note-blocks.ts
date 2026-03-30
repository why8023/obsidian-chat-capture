import {
	OBAR_RECORD_END_MARKER,
	OBAR_RECORD_START_MARKER,
	type MessageAnchorMetadata,
	buildMessageMatchKey,
	hashString,
	markdownToPlainText,
	normalizeMessageMarkdownBody,
	parseMessageAnchorMetadata,
	parseMessageHeadingRole,
} from "../message-anchor";

const CUSTOM_NOTE_START_MARKER = "obar-note-start";
const CUSTOM_NOTE_END_MARKER = "obar-note-end";
const CUSTOM_NOTE_CONTEXT_WINDOW = 160;
const CUSTOM_NOTE_ID_LENGTH = 12;
const CUSTOM_NOTE_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MESSAGE_HEADING_SOURCE = "^# (?:USER|AI)(?::.*)?$";
const MESSAGE_START_PREFIX = `<!-- ${OBAR_RECORD_START_MARKER}:`;
const MESSAGE_END_COMMENT = `<!-- ${OBAR_RECORD_END_MARKER} -->`;

interface CustomNoteBlock {
	start: number;
	end: number;
	fullText: string;
}

interface PositionedCustomNoteBlock extends CustomNoteBlock {
	strippedOffset: number;
}

interface BodySegment {
	start: number;
	end: number;
}

interface ParsedMessageBlock {
	index: number;
	start: number;
	end: number;
	contentStart: number;
	contentEnd: number;
	content: string;
	role: MessageAnchorMetadata["role"];
	matchKey?: string;
	contentHtmlHash?: string;
	contentHash?: string;
	customNoteBlocks: CustomNoteBlock[];
}

function createCustomNotePattern(): RegExp {
	return new RegExp(
		`<!--\\s*${CUSTOM_NOTE_START_MARKER}:[A-Za-z0-9-]+\\s*-->([\\s\\S]*?)<!--\\s*${CUSTOM_NOTE_END_MARKER}:[A-Za-z0-9-]+\\s*-->`,
		"g",
	);
}

function createMessageHeadingPattern(): RegExp {
	return new RegExp(MESSAGE_HEADING_SOURCE, "gm");
}

function createShortIdFallback(length = CUSTOM_NOTE_ID_LENGTH): string {
	let output = "";

	for (let index = 0; index < length; index += 1) {
		output +=
			CUSTOM_NOTE_ID_ALPHABET[
				Math.floor(Math.random() * CUSTOM_NOTE_ID_ALPHABET.length)
			] ?? "";
	}

	return output;
}

function createShortId(length = CUSTOM_NOTE_ID_LENGTH): string {
	const bytes = new Uint8Array(length);
	if (globalThis.crypto?.getRandomValues) {
		globalThis.crypto.getRandomValues(bytes);
	}

	if (!globalThis.crypto?.getRandomValues) {
		return createShortIdFallback(length);
	}

	return [...bytes]
		.map((value) => CUSTOM_NOTE_ID_ALPHABET[value & 31] ?? "")
		.join("");
}

function splitDocument(content: string): { frontmatter: string; body: string } {
	const match = content.match(/^---\n[\s\S]*?\n---\n?/);
	const frontmatter = match?.[0] ?? "";
	return {
		frontmatter,
		body: content.slice(frontmatter.length),
	};
}

function getBodySegments(body: string): BodySegment[] {
	const headingPattern = createMessageHeadingPattern();
	const headingStarts: number[] = [];
	let match: RegExpExecArray | null = headingPattern.exec(body);
	while (match) {
		headingStarts.push(match.index);
		match = headingPattern.exec(body);
	}

	if (headingStarts.length === 0) {
		return [
			{
				start: 0,
				end: body.length,
			},
		];
	}

	const segments: BodySegment[] = [
		{
			start: 0,
			end: headingStarts[0] ?? 0,
		},
	];

	headingStarts.forEach((start, index) => {
		segments.push({
			start,
			end: headingStarts[index + 1] ?? body.length,
		});
	});

	return segments;
}

function extractCustomNoteBlocks(content: string): CustomNoteBlock[] {
	const pattern = createCustomNotePattern();
	const blocks: CustomNoteBlock[] = [];
	let match: RegExpExecArray | null = pattern.exec(content);
	while (match) {
		blocks.push({
			start: match.index,
			end: pattern.lastIndex,
			fullText: match[0],
		});
		match = pattern.exec(content);
	}
	return blocks;
}

function stripCustomNoteBlocks(content: string): string {
	return content.replace(createCustomNotePattern(), "");
}

function buildAnchorCandidates(anchor: string, edge: "start" | "end"): string[] {
	const maxLength = Math.min(anchor.length, CUSTOM_NOTE_CONTEXT_WINDOW);
	const lengths = [maxLength, 120, 80, 40, 20].filter(
		(length, index, values) =>
			length > 0 && values.indexOf(length) === index,
	);

	return lengths.map((length) =>
		edge === "end" ? anchor.slice(-length) : anchor.slice(0, length),
	);
}

function findAllOccurrences(content: string, search: string): number[] {
	if (!search) {
		return [];
	}

	const offsets: number[] = [];
	let cursor = content.indexOf(search);
	while (cursor !== -1) {
		offsets.push(cursor);
		cursor = content.indexOf(search, cursor + 1);
	}
	return offsets;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function findInsertionOffset(
	content: string,
	prefixAnchor: string,
	suffixAnchor: string,
	fallbackOffset: number,
): number {
	const prefixCandidates = buildAnchorCandidates(prefixAnchor, "end");
	const suffixCandidates = buildAnchorCandidates(suffixAnchor, "start");

	for (const prefixCandidate of prefixCandidates) {
		const positions = findAllOccurrences(content, prefixCandidate);
		for (let index = positions.length - 1; index >= 0; index -= 1) {
			const position = positions[index];
			if (position === undefined) {
				continue;
			}

			const insertionOffset = position + prefixCandidate.length;
			if (
				suffixCandidates.length === 0 ||
				suffixCandidates.some(
					(suffixCandidate) =>
						content.indexOf(suffixCandidate, insertionOffset) !== -1,
				)
			) {
				return insertionOffset;
			}
		}
	}

	for (const suffixCandidate of suffixCandidates) {
		const position = content.indexOf(suffixCandidate);
		if (position !== -1) {
			return position;
		}
	}

	return clamp(fallbackOffset, 0, content.length);
}

function positionCustomNoteBlocks(segment: string): PositionedCustomNoteBlock[] {
	const blocks = extractCustomNoteBlocks(segment);
	let removedLength = 0;

	return blocks.map((block) => {
		const positionedBlock: PositionedCustomNoteBlock = {
			...block,
			strippedOffset: block.start - removedLength,
		};
		removedLength += block.fullText.length;
		return positionedBlock;
	});
}

function appendCustomBlocks(content: string, blocks: string[]): string {
	if (blocks.length === 0) {
		return content;
	}

	const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
	return `${content}${separator}${blocks.join("\n\n")}`;
}

function restoreSegmentCustomNoteBlocks(
	oldSegment: string,
	newSegment: string,
): string {
	const blocks = positionCustomNoteBlocks(oldSegment);
	if (blocks.length === 0) {
		return newSegment;
	}

	const strippedOldSegment = stripCustomNoteBlocks(oldSegment);
	let result = newSegment;

	for (let index = blocks.length - 1; index >= 0; index -= 1) {
		const block = blocks[index];
		if (!block) {
			continue;
		}

		const prefixAnchor = strippedOldSegment.slice(
			Math.max(0, block.strippedOffset - CUSTOM_NOTE_CONTEXT_WINDOW),
			block.strippedOffset,
		);
		const suffixAnchor = strippedOldSegment.slice(
			block.strippedOffset,
			Math.min(
				strippedOldSegment.length,
				block.strippedOffset + CUSTOM_NOTE_CONTEXT_WINDOW,
			),
		);
		const fallbackOffset =
			strippedOldSegment.length === 0
				? result.length
				: Math.round(
						(block.strippedOffset / strippedOldSegment.length) * result.length,
				  );
		const insertionOffset = findInsertionOffset(
			result,
			prefixAnchor,
			suffixAnchor,
			fallbackOffset,
		);

		result = `${result.slice(0, insertionOffset)}${block.fullText}${result.slice(
			insertionOffset,
		)}`;
	}

	return result;
}

function createParsedMessageBlock(options: {
	index: number;
	body: string;
	start: number;
	end: number;
	contentStart: number;
	contentEnd: number;
	metadata: MessageAnchorMetadata | null;
}): ParsedMessageBlock {
	const content = options.body.slice(options.contentStart, options.contentEnd);
	const customNoteBlocks = extractCustomNoteBlocks(content);
	const role =
		options.metadata?.role ??
		parseMessageHeadingRole(content) ??
		"unknown";
	const normalizedMarkdown = normalizeMessageMarkdownBody(
		stripCustomNoteBlocks(content),
	);
	const plainText = markdownToPlainText(normalizedMarkdown);
	const contentHash = normalizedMarkdown
		? hashString(`${role}|${normalizedMarkdown}`)
		: undefined;

	return {
		index: options.index,
		start: options.start,
		end: options.end,
		contentStart: options.contentStart,
		contentEnd: options.contentEnd,
		content,
		role,
		matchKey:
			options.metadata?.matchKey ??
			(plainText ? buildMessageMatchKey(role, plainText) : undefined),
		contentHtmlHash: options.metadata?.contentHtmlHash,
		contentHash,
		customNoteBlocks,
	};
}

function parseAnchoredMessageBlocks(body: string): ParsedMessageBlock[] {
	const blocks: ParsedMessageBlock[] = [];
	let searchFrom = 0;

	while (searchFrom < body.length) {
		const start = body.indexOf(MESSAGE_START_PREFIX, searchFrom);
		if (start === -1) {
			break;
		}

		const markerEnd = body.indexOf("-->", start);
		if (markerEnd === -1) {
			break;
		}

		const metadata = parseMessageAnchorMetadata(
			body.slice(start + MESSAGE_START_PREFIX.length, markerEnd).trim(),
		);
		const contentStart = markerEnd + 3;
		const endStart = body.indexOf(MESSAGE_END_COMMENT, contentStart);
		if (endStart === -1) {
			break;
		}

		const end = endStart + MESSAGE_END_COMMENT.length;
		blocks.push(
			createParsedMessageBlock({
				index: blocks.length,
				body,
				start,
				end,
				contentStart,
				contentEnd: endStart,
				metadata,
			}),
		);
		searchFrom = end;
	}

	return blocks;
}

function parseLegacyMessageBlocks(body: string): ParsedMessageBlock[] {
	const segments = getBodySegments(body);
	const blocks: ParsedMessageBlock[] = [];

	for (const segment of segments) {
		const content = body.slice(segment.start, segment.end);
		if (!parseMessageHeadingRole(content)) {
			continue;
		}

		blocks.push(
			createParsedMessageBlock({
				index: blocks.length,
				body,
				start: segment.start,
				end: segment.end,
				contentStart: segment.start,
				contentEnd: segment.end,
				metadata: null,
			}),
		);
	}

	return blocks;
}

function parseMessageBlocks(body: string): ParsedMessageBlock[] {
	const anchoredBlocks = parseAnchoredMessageBlocks(body);
	if (anchoredBlocks.length > 0) {
		return anchoredBlocks;
	}

	return parseLegacyMessageBlocks(body);
}

function isBlockContainedInRange(
	block: CustomNoteBlock,
	start: number,
	end: number,
): boolean {
	return block.start >= start && block.end <= end;
}

function collectStandaloneCustomNoteBlocks(
	body: string,
	messageBlocks: ParsedMessageBlock[],
): string[] {
	const customBlocks = extractCustomNoteBlocks(body);
	return customBlocks
		.filter(
			(block) =>
				!messageBlocks.some((messageBlock) =>
					isBlockContainedInRange(block, messageBlock.start, messageBlock.end),
				),
		)
		.map((block) => block.fullText);
}

function pairUniqueByFingerprint(
	oldBlocks: ParsedMessageBlock[],
	newBlocks: ParsedMessageBlock[],
	matches: Map<number, number>,
	usedNew: Set<number>,
	getFingerprint: (block: ParsedMessageBlock) => string | undefined,
): void {
	const oldByFingerprint = new Map<string, ParsedMessageBlock[]>();
	const newByFingerprint = new Map<string, ParsedMessageBlock[]>();

	for (const block of oldBlocks) {
		if (matches.has(block.index)) {
			continue;
		}
		const fingerprint = getFingerprint(block);
		if (!fingerprint) {
			continue;
		}

		const group = oldByFingerprint.get(fingerprint) ?? [];
		group.push(block);
		oldByFingerprint.set(fingerprint, group);
	}

	for (const block of newBlocks) {
		if (usedNew.has(block.index)) {
			continue;
		}
		const fingerprint = getFingerprint(block);
		if (!fingerprint) {
			continue;
		}

		const group = newByFingerprint.get(fingerprint) ?? [];
		group.push(block);
		newByFingerprint.set(fingerprint, group);
	}

	for (const [fingerprint, oldGroup] of oldByFingerprint.entries()) {
		const newGroup = newByFingerprint.get(fingerprint);
		if (!newGroup || oldGroup.length !== 1 || newGroup.length !== 1) {
			continue;
		}

		const [oldBlock] = oldGroup;
		const [newBlock] = newGroup;
		if (!oldBlock || !newBlock) {
			continue;
		}

		matches.set(oldBlock.index, newBlock.index);
		usedNew.add(newBlock.index);
	}
}

function pairRemainingByGroup(
	oldBlocks: ParsedMessageBlock[],
	newBlocks: ParsedMessageBlock[],
	matches: Map<number, number>,
	usedNew: Set<number>,
	getGroupKey: (block: ParsedMessageBlock) => string | undefined,
): void {
	const oldGroups = new Map<string, ParsedMessageBlock[]>();
	const newGroups = new Map<string, ParsedMessageBlock[]>();

	for (const block of oldBlocks) {
		if (matches.has(block.index)) {
			continue;
		}
		const key = getGroupKey(block);
		if (!key) {
			continue;
		}

		const group = oldGroups.get(key) ?? [];
		group.push(block);
		oldGroups.set(key, group);
	}

	for (const block of newBlocks) {
		if (usedNew.has(block.index)) {
			continue;
		}
		const key = getGroupKey(block);
		if (!key) {
			continue;
		}

		const group = newGroups.get(key) ?? [];
		group.push(block);
		newGroups.set(key, group);
	}

	for (const [key, oldGroup] of oldGroups.entries()) {
		const newGroup = newGroups.get(key);
		if (!newGroup || newGroup.length === 0) {
			continue;
		}

		pairUniqueByFingerprint(oldGroup, newGroup, matches, usedNew, (block) =>
			block.contentHtmlHash
				? `${block.matchKey ?? key}|html|${block.contentHtmlHash}`
				: undefined,
		);
		pairUniqueByFingerprint(oldGroup, newGroup, matches, usedNew, (block) =>
			block.contentHash ? `${block.role}|content|${block.contentHash}` : undefined,
		);

		const remainingOld = oldGroup.filter((block) => !matches.has(block.index));
		const remainingNew = newGroup.filter((block) => !usedNew.has(block.index));
		const pairCount = Math.min(remainingOld.length, remainingNew.length);
		for (let index = 0; index < pairCount; index += 1) {
			const oldBlock = remainingOld[index];
			const newBlock = remainingNew[index];
			if (!oldBlock || !newBlock) {
				continue;
			}

			matches.set(oldBlock.index, newBlock.index);
			usedNew.add(newBlock.index);
		}
	}
}

function matchMessageBlocks(
	oldBlocks: ParsedMessageBlock[],
	newBlocks: ParsedMessageBlock[],
): Map<number, number> {
	const matches = new Map<number, number>();
	const usedNew = new Set<number>();

	pairUniqueByFingerprint(oldBlocks, newBlocks, matches, usedNew, (block) =>
		block.matchKey && block.contentHtmlHash
			? `${block.matchKey}|${block.contentHtmlHash}`
			: undefined,
	);
	pairUniqueByFingerprint(oldBlocks, newBlocks, matches, usedNew, (block) =>
		block.matchKey,
	);
	pairUniqueByFingerprint(oldBlocks, newBlocks, matches, usedNew, (block) =>
		block.contentHash ? `${block.role}|${block.contentHash}` : undefined,
	);
	pairRemainingByGroup(oldBlocks, newBlocks, matches, usedNew, (block) =>
		block.matchKey ??
		(block.contentHash ? `${block.role}|${block.contentHash}` : undefined),
	);

	return matches;
}

function restoreCustomNoteBlocks(existingBody: string, newBody: string): string {
	const existingBlocks = parseMessageBlocks(existingBody);
	const newBlocks = parseMessageBlocks(newBody);
	const standaloneBlocks = collectStandaloneCustomNoteBlocks(existingBody, existingBlocks);
	const noteBlocks = existingBlocks.filter((block) => block.customNoteBlocks.length > 0);

	if (noteBlocks.length === 0) {
		return appendCustomBlocks(newBody, standaloneBlocks);
	}

	if (newBlocks.length === 0) {
		return appendCustomBlocks(newBody, [
			...standaloneBlocks,
			...noteBlocks.flatMap((block) =>
				block.customNoteBlocks.map((note) => note.fullText),
			),
		]);
	}

	const matches = matchMessageBlocks(noteBlocks, newBlocks);
	const orphanBlocks = [...standaloneBlocks];
	const replacements: Array<{ block: ParsedMessageBlock; content: string }> = [];

	for (const oldBlock of noteBlocks) {
		const matchedIndex = matches.get(oldBlock.index);
		if (matchedIndex === undefined) {
			orphanBlocks.push(...oldBlock.customNoteBlocks.map((note) => note.fullText));
			continue;
		}

		const newBlock = newBlocks[matchedIndex];
		if (!newBlock) {
			orphanBlocks.push(...oldBlock.customNoteBlocks.map((note) => note.fullText));
			continue;
		}

		replacements.push({
			block: newBlock,
			content: restoreSegmentCustomNoteBlocks(oldBlock.content, newBlock.content),
		});
	}

	let result = newBody;
	replacements
		.sort((left, right) => right.block.contentStart - left.block.contentStart)
		.forEach(({ block, content }) => {
			result = `${result.slice(0, block.contentStart)}${content}${result.slice(
				block.contentEnd,
			)}`;
		});

	return appendCustomBlocks(result, orphanBlocks);
}

export function createCustomNoteId(): string {
	return createShortId();
}

export function renderCustomNoteBlock(
	content = "",
	id = createCustomNoteId(),
): string {
	const normalizedContent = content.replace(/\r\n/g, "\n");
	if (normalizedContent.length === 0) {
		return [
			`<!-- ${CUSTOM_NOTE_START_MARKER}:${id}-->`,
			"",
			"",
			`<!-- ${CUSTOM_NOTE_END_MARKER}:${id}-->`,
		].join("\n");
	}

	return `<!-- ${CUSTOM_NOTE_START_MARKER}:${id}-->\n${normalizedContent}${
		normalizedContent.endsWith("\n") ? "" : "\n"
	}<!-- ${CUSTOM_NOTE_END_MARKER}:${id}-->`;
}

export function mergeRecordMarkdownWithCustomNotes(options: {
	existingContent: string;
	renderedContent: string;
}): string {
	if (!options.existingContent) {
		return options.renderedContent;
	}

	const { frontmatter, body: newBody } = splitDocument(options.renderedContent);
	const { body: existingBody } = splitDocument(options.existingContent);
	return `${frontmatter}${restoreCustomNoteBlocks(existingBody, newBody)}`;
}
