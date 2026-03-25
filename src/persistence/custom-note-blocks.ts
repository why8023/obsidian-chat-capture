const CUSTOM_NOTE_START_MARKER = "OBAR-CUSTOM-NOTE-START";
const CUSTOM_NOTE_END_MARKER = "OBAR-CUSTOM-NOTE-END";
const CUSTOM_NOTE_CONTEXT_WINDOW = 160;
const MESSAGE_HEADING_SOURCE = "^# (?:USER|AI)(?::.*)?$";

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

function createCustomNotePattern(): RegExp {
	return new RegExp(
		`<!--\\s*${CUSTOM_NOTE_START_MARKER}:[A-Za-z0-9-]+\\s*-->([\\s\\S]*?)<!--\\s*${CUSTOM_NOTE_END_MARKER}:[A-Za-z0-9-]+\\s*-->`,
		"g",
	);
}

function createMessageHeadingPattern(): RegExp {
	return new RegExp(MESSAGE_HEADING_SOURCE, "gm");
}

function createUuidFallback(): string {
	const bytes = new Uint8Array(16);
	if (globalThis.crypto?.getRandomValues) {
		globalThis.crypto.getRandomValues(bytes);
	} else {
		for (let index = 0; index < bytes.length; index += 1) {
			bytes[index] = Math.floor(Math.random() * 256);
		}
	}

	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;

	const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
	return [
		hex.slice(0, 4).join(""),
		hex.slice(4, 6).join(""),
		hex.slice(6, 8).join(""),
		hex.slice(8, 10).join(""),
		hex.slice(10, 16).join(""),
	].join("-");
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

function restoreCustomNoteBlocks(existingBody: string, newBody: string): string {
	const existingBlocks = extractCustomNoteBlocks(existingBody);
	if (existingBlocks.length === 0) {
		return newBody;
	}

	const existingSegments = getBodySegments(existingBody);
	const newSegments = getBodySegments(newBody);
	let result = newBody;
	const orphanBlocks: string[] = [];

	for (let index = existingSegments.length - 1; index >= 0; index -= 1) {
		const existingSegment = existingSegments[index];
		if (!existingSegment) {
			continue;
		}

		const oldSegment = existingBody.slice(existingSegment.start, existingSegment.end);
		const segmentBlocks = extractCustomNoteBlocks(oldSegment);
		if (segmentBlocks.length === 0) {
			continue;
		}

		const newSegmentRange = newSegments[index];
		if (!newSegmentRange) {
			orphanBlocks.unshift(...segmentBlocks.map((block) => block.fullText));
			continue;
		}

		const newSegment = result.slice(newSegmentRange.start, newSegmentRange.end);
		const restoredSegment = restoreSegmentCustomNoteBlocks(oldSegment, newSegment);
		result = `${result.slice(0, newSegmentRange.start)}${restoredSegment}${result.slice(
			newSegmentRange.end,
		)}`;
	}

	return appendCustomBlocks(result, orphanBlocks);
}

export function createCustomNoteId(): string {
	return globalThis.crypto?.randomUUID?.() ?? createUuidFallback();
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

export function mergeConversationMarkdownWithCustomNotes(options: {
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
