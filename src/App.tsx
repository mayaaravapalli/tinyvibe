import { useMemo, useState } from 'react'
import { pickVibe, pickWisdom, VIBES, type Vibe } from './vibes'
import { clearHistory, recordRoll, useAppData } from './store'

const ROLL_MS = 520

export default function App() {
  const [data, refresh] = useAppData()
  const [vibe, setVibe] = useState<Vibe | null>(() =>
    data.lastVibeId ? (VIBES.find((v) => v.id === data.lastVibeId) ?? null) : null,
  )
  const [rolling, setRolling] = useState(false)
  const [wisdom] = useState(() => pickWisdom())

  const historyVibes = useMemo(
    () =>
      data.history
        .map((r) => VIBES.find((v) => v.id === r.vibeId))
        .filter((v): v is Vibe => Boolean(v))
        .slice(0, 5),
    [data.history],
  )

  const roll = () => {
    if (rolling) return
    setRolling(true)

    window.setTimeout(() => {
      const next = pickVibe(vibe?.id)
      recordRoll(next.id)
      setVibe(next)
      refresh()
      setRolling(false)
    }, ROLL_MS)
  }

  const reset = () => {
    clearHistory()
    setVibe(null)
    refresh()
  }

  return (
    <div className="app">
      <div className="shell-card">
        <header className="app-header">
          <div className="title-lockup">
            <span className="spark-mark" aria-hidden>
              ✨
            </span>
            <div>
              <p className="eyebrow">some days just need a vibe</p>
              <h1 className="brand-title">tiny vibe</h1>
            </div>
          </div>
          {data.streak > 0 && (
            <span className="streak-pill" title="days in a row with a vibe">
              🔥 {data.streak} day{data.streak === 1 ? '' : 's'}
            </span>
          )}
        </header>

        <main className="main">
          <div className="page">
            <div className="page-header">
              <div>
                <p className="eyebrow">today's assignment</p>
                <h2 className="page-title">your vibe today</h2>
              </div>
              {data.totalRolls > 0 && (
                <p className="roll-count">
                  <span className="eyebrow">vibes</span>
                  <strong>{String(data.totalRolls).padStart(2, '0')}</strong>
                </p>
              )}
            </div>

            <div className="wisdom">
              <p className="eyebrow">tiny wisdom</p>
              <p>{wisdom}</p>
            </div>

            {vibe ? (
              <article className={`vibe-card accent-${vibe.accent}`} aria-live="polite">
                <span className="vibe-emoji" aria-hidden>
                  {vibe.emoji}
                </span>
                <p className="eyebrow">your vibe is</p>
                <h3 className="vibe-name">{vibe.name}</h3>
                <p className="vibe-tagline">{vibe.tagline}</p>
                <div className="vibe-action">
                  <p className="eyebrow">do this</p>
                  <p>{vibe.action}</p>
                </div>
              </article>
            ) : (
              <div className="empty">
                <span className="empty-mark" aria-hidden>
                  ?
                </span>
                <h3 className="empty-title">no vibe yet</h3>
                <p className="empty-body">
                  One click. One vibe. Zero committee meetings about how you should feel today.
                </p>
              </div>
            )}

            <button
              type="button"
              className={`big-button${rolling ? ' is-working' : ''}`}
              onClick={roll}
              disabled={rolling}
            >
              {rolling ? 'finding your vibe…' : vibe ? 'roll again' : 'roll my vibe'}
            </button>

            {historyVibes.length > 1 && (
              <section className="history">
                <p className="eyebrow section-label">recent vibes</p>
                <div className="history-chips">
                  {historyVibes.map((v, i) => (
                    <span key={`${v.id}-${i}`} className="chip" title={v.name}>
                      {v.emoji} {v.name}
                    </span>
                  ))}
                </div>
                <button type="button" className="text-button" onClick={reset}>
                  clear history
                </button>
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
