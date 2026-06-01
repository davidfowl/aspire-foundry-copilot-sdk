import { useState, useRef, useEffect } from 'react'
import './App.css'

// The server owns the HttpOnly identity cookie and the Foundry session id. The browser only receives a
// non-secret display id for local transcript storage.
function historyKey(id) {
  return `chat-history:${id}`
}

function loadHistory(id) {
  try {
    return JSON.parse(localStorage.getItem(historyKey(id))) ?? []
  } catch {
    return []
  }
}

function saveHistory(id, messages) {
  try {
    localStorage.setItem(historyKey(id), JSON.stringify(messages))
  } catch {
    // Ignore quota / serialization errors; history persistence is best-effort.
  }
}

function removeLegacySessionStorage() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('foundry-session:')) {
        localStorage.removeItem(key)
      }
    }
  } catch {
    // Ignore storage access errors; the app no longer reads these legacy secrets.
  }
}

function Message({ role, content }) {
  return (
    <div className={`message ${role}`}>
      <span className="bubble">{content}</span>
    </div>
  )
}

function shortId(value) {
  return value ? `${value.slice(0, 8)}...` : 'Loading'
}

export default function App() {
  const [session, setSession] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    removeLegacySessionStorage()
    refreshSession()
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  useEffect(() => {
    if (session) {
      saveHistory(session.id, messages)
    }
  }, [session, messages])

  async function refreshSession() {
    const res = await fetch('/session')
    const next = await res.json()
    setSession(next)
    setMessages(loadHistory(next.id))
  }

  async function switchUser() {
    if (loading) return
    setLoading(true)
    try {
      const res = await fetch('/session/reset', { method: 'POST' })
      const next = await res.json()
      setSession(next)
      setMessages(loadHistory(next.id))
    } finally {
      setLoading(false)
    }
  }

  async function send() {
    const text = input.trim()
    if (!text || loading || !session) return
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: text }])
    setLoading(true)
    try {
      const res = await fetch('/invocations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      const data = await res.json()
      const reply = data?.output?.content ?? data?.error ?? '(no response)'
      if (data?.session) {
        setSession(data.session)
      }
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e.message}` }])
    } finally {
      setLoading(false)
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Foundry hosted agent</p>
          <h1>Agent Chat</h1>
          <p className="description">
            Test a browser-isolated conversation backed by a Foundry agent sandbox.
          </p>
        </div>

        <div className="identity-card">
          <span className="label">Current user</span>
          <strong>{session?.name ?? 'Loading...'}</strong>
          <dl>
            <div>
              <dt>User handle</dt>
              <dd>{shortId(session?.id)}</dd>
            </div>
            <div>
              <dt>Agent session</dt>
              <dd>{session?.has_agent_session ? 'Server managed' : 'Not started'}</dd>
            </div>
          </dl>
          <button className="secondary-button" onClick={switchUser} disabled={loading}>
            New isolated user
          </button>
        </div>
      </aside>

      <main className="chat-panel">
        <header className="chat-header">
          <div>
            <span className="label">Conversation</span>
            <h2>{session?.name ?? 'Loading...'}</h2>
          </div>
          <span className="status">{loading ? 'Waiting for agent' : 'Ready'}</span>
        </header>

        <div className="chat-messages">
          {messages.length === 0 && (
            <div className="empty-state">
              Send a message to start a new Foundry agent session for this user.
            </div>
          )}
          {messages.map((m, i) => <Message key={i} {...m} />)}
          {loading && <div className="message assistant"><span className="bubble typing">...</span></div>}
          <div ref={bottomRef} />
        </div>

        <div className="chat-input">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a message and press Enter"
            rows={3}
            disabled={loading || !session}
          />
          <button onClick={send} disabled={loading || !session || !input.trim()}>Send</button>
        </div>
      </main>
    </div>
  )
}
