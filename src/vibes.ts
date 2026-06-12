export type VibeAccent = 'pink' | 'purple' | 'yellow' | 'mint' | 'lime'

export type Vibe = {
  id: string
  emoji: string
  name: string
  tagline: string
  action: string
  accent: VibeAccent
}

export const VIBES: Vibe[] = [
  {
    id: 'cozy-goblin',
    emoji: '🫖',
    name: 'cozy goblin',
    tagline: 'Small comforts. Low stakes. Maybe a blanket fort.',
    action: 'Make one thing unnecessarily cozy before noon.',
    accent: 'pink',
  },
  {
    id: 'main-character',
    emoji: '✨',
    name: 'main character',
    tagline: 'The universe is doing B-roll. You are the plot.',
    action: 'Walk somewhere like the soundtrack just dropped.',
    accent: 'purple',
  },
  {
    id: 'gentle-chaos',
    emoji: '🌀',
    name: 'gentle chaos',
    tagline: 'Productive enough to feel alive. Messy enough to be human.',
    action: 'Start something weird. Finish nothing. Feel great.',
    accent: 'yellow',
  },
  {
    id: 'soft-focus',
    emoji: '🌫️',
    name: 'soft focus',
    tagline: 'Not lazy — ambient. Ideas arrive on their own schedule.',
    action: 'One deep breath, then one tiny task. Repeat once.',
    accent: 'mint',
  },
  {
    id: 'feral-optimist',
    emoji: '🦊',
    name: 'feral optimist',
    tagline: 'Unhinged hope. Mild delusion. Surprisingly effective.',
    action: 'Say yes to one thing you would normally overthink.',
    accent: 'lime',
  },
  {
    id: 'quiet-rebel',
    emoji: '🖤',
    name: 'quiet rebel',
    tagline: 'No announcements. Just doing the thing anyway.',
    action: 'Ignore one "should" and do the thing you actually want.',
    accent: 'purple',
  },
  {
    id: 'sunbeam-mode',
    emoji: '☀️',
    name: 'sunbeam mode',
    tagline: 'Warm, bright, slightly too enthusiastic for email.',
    action: 'Send one kind message with zero agenda.',
    accent: 'yellow',
  },
  {
    id: 'deep-noodle',
    emoji: '🍜',
    name: 'deep noodle',
    tagline: 'Contemplative. Saucy. Possibly overthinking soup.',
    action: 'Journal three sentences. No editing. Close the tab.',
    accent: 'pink',
  },
  {
    id: 'park-bench',
    emoji: '🪵',
    name: 'park bench energy',
    tagline: 'Observing life like a very wise pigeon.',
    action: 'Sit somewhere new for five minutes. Phone face-down.',
    accent: 'mint',
  },
  {
    id: 'spark-collector',
    emoji: '⚡',
    name: 'spark collector',
    tagline: 'Tiny wins only. Hoard them like shiny pebbles.',
    action: 'Do the smallest version of the thing. Celebrate loudly.',
    accent: 'lime',
  },
  {
    id: 'night-owl-lite',
    emoji: '🌙',
    name: 'night owl lite',
    tagline: 'Melancholy but cute. Like a sad lamp with good taste.',
    action: 'Put on one song and let it pick your mood.',
    accent: 'purple',
  },
  {
    id: 'golden-retriever',
    emoji: '🐕',
    name: 'golden retriever',
    tagline: 'Enthusiastic about everything. Including snacks.',
    action: 'Text someone "thinking of you" with zero follow-up needed.',
    accent: 'yellow',
  },
]

export const WISDOM: string[] = [
  'You do not need a reason to feel okay today.',
  'Mood is weather. You are the sky.',
  'Sometimes the vibe chooses you.',
  'Small is not less. Small is how things start.',
  'Overthinking is just vibes with paperwork.',
  'Your vibes know things your calendar does not.',
  'Permission granted. You were always allowed.',
  'Not every day needs a plan. Some days just need a vibe.',
]

export function pickVibe(excludeId?: string): Vibe {
  const pool = excludeId ? VIBES.filter((v) => v.id !== excludeId) : VIBES
  return pool[Math.floor(Math.random() * pool.length)]!
}

export function pickWisdom(): string {
  return WISDOM[Math.floor(Math.random() * WISDOM.length)]!
}
