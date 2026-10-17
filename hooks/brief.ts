// The /brief skill's rules for explain answers: read from ~/.claude/skills/brief/SKILL.md.

export const BRIEF_PATH = '.claude/skills/brief/SKILL.md'

// Used when the skill file is missing or unreadable.
export const BRIEF_FALLBACK = `Answer in brief mode:
- Same language as the question; technical terms stay in English.
- Cut words, never information: keep every case, condition, number, path and caveat.
- No openers, recaps, offers or closers.
- One fact: 1-3 sentences. Several points: bold one-line conclusions, one supporting fact per sub-bullet.
- Explain what code does and when, not line by line.`

// The skill file's body, without its frontmatter.
export const briefRules = (skill: string | undefined) =>
  skill?.replace(/^---\n[\s\S]*?\n---\n/, '').trim() || BRIEF_FALLBACK
