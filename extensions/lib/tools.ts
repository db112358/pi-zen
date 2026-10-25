/**
 * The per-tool choices, in one table: which tools are narrative rows, which hide
 * their result behind a header, and what a counted result counts.
 */

export interface ToolProfile {
	/** Heads its own chapter and keeps its own row: its result is the narrative. */
	narrative?: boolean;
	/** Hides its whole result when collapsed; only a failure earns a summary line. */
	headerOnly?: boolean;
	/** What a counted result counts, when the tool counts something other than lines. */
	noun?: string;
}

/** Every tool drawn differently from the default row; a tool absent here takes the default. */
const PROFILES: Readonly<Record<string, ToolProfile>> = {
	set_andon: { narrative: true },
	read: { headerOnly: true },
	write: { headerOnly: true },
	grep: { noun: "matches" },
	find: { noun: "files" },
	ls: { noun: "entries" },
};

const DEFAULT_PROFILE: ToolProfile = {};

/** A tool's choices; a tool the table does not name draws the default row. */
export function toolProfile(toolName: string): ToolProfile {
	return PROFILES[toolName] ?? DEFAULT_PROFILE;
}

/** Whether the tool heads its own chapter, so its row is the narrative. */
export function narrative(toolName: string): boolean {
	return toolProfile(toolName).narrative === true;
}

/** Whether the tool hides its whole result when collapsed. */
export function headerOnly(toolName: string): boolean {
	return toolProfile(toolName).headerOnly === true;
}

/** The noun a counted result uses; undefined means the tool counts lines. */
export function countNoun(toolName: string): string | undefined {
	return toolProfile(toolName).noun;
}
