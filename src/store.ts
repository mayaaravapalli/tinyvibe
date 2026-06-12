import { useEffect, useState } from 'react'

const STORAGE_KEY = 'tinyroll:v1'

export type RollRecord = {
  vibeId: string
  at: string
}

export type AppData = {
  totalRolls: number
  streak: number
  lastRollDay: string | null
  history: RollRecord[]
  lastVibeId: string | null
}

const DEFAULT: AppData = {
  totalRolls: 0,
  streak: 0,
  lastRollDay: null,
  history: [],
  lastVibeId: null,
}

function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

function yesterdayKey(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return dayKey(d)
}

function read(): AppData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT
    return { ...DEFAULT, ...JSON.parse(raw) } as AppData
  } catch {
    return DEFAULT
  }
}

function write(data: AppData) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
}

export function recordRoll(vibeId: string): AppData {
  const prev = read()
  const today = dayKey()
  const rolledYesterday = prev.lastRollDay === yesterdayKey()
  const alreadyToday = prev.lastRollDay === today

  let streak = prev.streak
  if (!alreadyToday) {
    streak = rolledYesterday ? prev.streak + 1 : 1
  }

  const next: AppData = {
    totalRolls: prev.totalRolls + 1,
    streak,
    lastRollDay: today,
    lastVibeId: vibeId,
    history: [{ vibeId, at: new Date().toISOString() }, ...prev.history].slice(0, 8),
  }

  write(next)
  return next
}

export function useAppData(): [AppData, () => void] {
  const [data, setData] = useState<AppData>(read)

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setData(read())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const refresh = () => setData(read())

  return [data, refresh]
}

export function clearHistory() {
  write({ ...read(), history: [], totalRolls: 0, streak: 0, lastRollDay: null, lastVibeId: null })
}
