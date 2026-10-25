import "./App.css"
import { Editor } from "@monaco-editor/react"
import { MonacoBinding } from "y-monaco"
import { useRef, useMemo, useState, useEffect, useCallback } from "react"
import * as Y from "yjs"
import { SocketIOProvider } from "y-socket.io"

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B"
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB"
  return (bytes / 1024 / 1024).toFixed(1) + " MB"
}

// Languages the Run button offers. `monaco` is the editor's syntax id; `piston`
// is the name the Piston API expects -- they differ (e.g. cpp vs c++).
const LANGUAGES = [
  { label: "JavaScript", monaco: "javascript", piston: "javascript" },
  { label: "Python",     monaco: "python",     piston: "python" },
  { label: "TypeScript", monaco: "typescript", piston: "typescript" },
  { label: "Java",       monaco: "java",       piston: "java" },
  { label: "C++",        monaco: "cpp",        piston: "c++" },
  { label: "Go",         monaco: "go",         piston: "go" },
]

function App() {

  const editorRef = useRef(null)

  // Both username and room come from the URL so a refresh (or a shared link
  // like ?username=Ana&room=ABC123) drops you straight back into the room.
  const params = new URLSearchParams(window.location.search)
  const [ username, setUsername ] = useState(() => params.get("username") || "")
  const [ room, setRoom ] = useState(() => (params.get("room") || "").toUpperCase())
  const [ users, setUsers ] = useState([])

  // Files in the current room.
  const [ files, setFiles ] = useState([])
  const [ uploading, setUploading ] = useState(false)
  const [ fileError, setFileError ] = useState("")

  // Code-runner state. `language` holds the Piston name of the chosen language.
  const [ language, setLanguage ] = useState("javascript")
  const [ output, setOutput ] = useState(null)   // { stdout, stderr, exitCode } | null
  const [ running, setRunning ] = useState(false)

  // Lobby-only form state.
  const [ name, setName ] = useState("")
  const [ joinCode, setJoinCode ] = useState("")
  const [ error, setError ] = useState("")
  const [ busy, setBusy ] = useState(false)

  // A fresh Yjs doc per room. The room is the doc name the provider syncs under.
  const ydoc = useMemo(() => new Y.Doc(), [ room ])
  const yText = useMemo(() => ydoc.getText("monaco"), [ ydoc ])


  const handleMount = (editor) => {
    editorRef.current = editor
    new MonacoBinding(
      yText,
      editorRef.current.getModel(),
      new Set([ editorRef.current ]),
    )
  }


  // Commit a successful create/join: remember who/where and update the URL.
  const enter = (name, code) => {
    setUsername(name)
    setRoom(code)
    const qs = new URLSearchParams({ username: name, room: code })
    window.history.pushState({}, "", "?" + qs.toString())
  }

  const handleCreate = async () => {
    setError("")
    if (!name.trim()) { setError("Enter your name first"); return }
    setBusy(true)
    try {
      const res = await fetch("/api/rooms", { method: "POST" })
      if (!res.ok) throw new Error()
      const { code } = await res.json()
      enter(name.trim(), code)
    } catch {
      setError("Could not create a room. Is the server running?")
    } finally {
      setBusy(false)
    }
  }

  const handleJoin = async (e) => {
    e.preventDefault()
    setError("")
    if (!name.trim()) { setError("Enter your name first"); return }
    const code = joinCode.trim().toUpperCase()
    if (!code) { setError("Enter a room code"); return }
    setBusy(true)
    try {
      const res = await fetch("/api/rooms/" + code)
      if (res.status === 404) { setError("No room with that code"); return }
      if (!res.ok) throw new Error()
      enter(name.trim(), code)
    } catch {
      setError("Could not reach the server")
    } finally {
      setBusy(false)
    }
  }


  // --- Files ----------------------------------------------------------------
  const fetchFiles = useCallback(async () => {
    if (!room) return
    try {
      const res = await fetch(`/api/rooms/${room}/files`)
      if (res.ok) setFiles(await res.json())
    } catch { /* ignore transient errors */ }
  }, [ room ])

  const handleUpload = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ""            // let the same file be re-picked later
    if (!file) return
    setFileError("")
    setUploading(true)
    try {
      const body = new FormData()
      body.append("file", file)
      body.append("username", username)
      const res = await fetch(`/api/rooms/${room}/files`, { method: "POST", body })
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}))
        setFileError(error || "Upload failed")
        return
      }
      await fetchFiles()
    } catch {
      setFileError("Upload failed")
    } finally {
      setUploading(false)
    }
  }

  const openFile = async (id) => {
    try {
      const res = await fetch(`/api/rooms/${room}/files/${id}/url`)
      if (!res.ok) return
      const { url } = await res.json()
      window.open(url, "_blank", "noopener")
    } catch { /* ignore */ }
  }


  // --- Run code -------------------------------------------------------------
  // Send the editor's current text to OUR backend, which proxies it to Piston.
  const handleRun = async () => {
    const code = editorRef.current?.getValue() ?? ""
    setRunning(true)
    setOutput(null)
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, code }),
      })
      const data = await res.json().catch(() => ({}))
      setOutput(res.ok ? data : { stderr: data.error || "Run failed" })
    } catch {
      setOutput({ stderr: "Could not reach the server" })
    } finally {
      setRunning(false)
    }
  }

  // Monaco's syntax id for the selected language (falls back to plaintext).
  const monacoLang = LANGUAGES.find((l) => l.piston === language)?.monaco ?? "javascript"


  useEffect(() => {
    if (username && room) {
      // The room code is the document name: everyone on the same code shares
      // one doc and sees each other; a different code is a separate world.
      const provider = new SocketIOProvider("/", room, ydoc, { autoConnect: true })
      provider.awareness.setLocalStateField("user", { username })

      const update = () => {
        const states = Array.from(provider.awareness.getStates().values())
        setUsers(states.filter(s => s.user && s.user.username).map(s => s.user))
      }
      update()
      provider.awareness.on("change", update)

      function handleBeforeUnload() {
        provider.awareness.setLocalStateField("user", null)
      }
      window.addEventListener("beforeunload", handleBeforeUnload)

      return () => {
        provider.disconnect()
        provider.awareness.off("change", update)
        window.removeEventListener("beforeunload", handleBeforeUnload)
      }
    }
  }, [ username, room, ydoc ])

  // Load the room's files on entry, and poll so others' uploads show up too.
  useEffect(() => {
    if (!username || !room) return
    fetchFiles()
    const t = setInterval(fetchFiles, 5000)
    return () => clearInterval(t)
  }, [ username, room, fetchFiles ])


  // --- Lobby: pick a name, then create or join a room -----------------------
  if (!username || !room) {
    return (
      <main className="h-screen w-full bg-gray-950 flex items-center justify-center p-4">
        <div className="w-full max-w-sm flex flex-col gap-6">
          <h1 className="text-amber-50 text-3xl font-bold text-center">CodeTogether</h1>

          <input
            type="text"
            placeholder="Enter your name"
            className="p-3 rounded-lg bg-gray-800 text-white outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          <button
            onClick={handleCreate}
            disabled={busy}
            className="p-3 rounded-lg bg-amber-50 text-gray-950 font-bold disabled:opacity-50"
          >
            {busy ? "Working…" : "Create a new room"}
          </button>

          <div className="flex items-center gap-3 text-gray-500 text-sm">
            <span className="h-px flex-1 bg-gray-800" /> or join one <span className="h-px flex-1 bg-gray-800" />
          </div>

          <form onSubmit={handleJoin} className="flex gap-2">
            <input
              type="text"
              placeholder="Room code"
              className="p-3 rounded-lg bg-gray-800 text-white outline-none flex-1 uppercase tracking-widest"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
            />
            <button
              type="submit"
              disabled={busy}
              className="px-5 rounded-lg bg-gray-700 text-white font-bold disabled:opacity-50"
            >
              Join
            </button>
          </form>

          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
        </div>
      </main>
    )
  }

  // --- Room: the shared editor + users + files ------------------------------
  return (
    <main className="h-screen w-full bg-gray-950 flex gap-4 p-4">
      <aside className="h-full w-1/4 bg-amber-50 rounded-lg flex flex-col overflow-hidden">
        <div className="p-4 border-b border-gray-300">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Room code</p>
          <div className="flex items-center justify-between gap-2">
            <span className="text-2xl font-bold tracking-widest">{room}</span>
            <button
              onClick={() => navigator.clipboard?.writeText(room)}
              className="text-xs px-2 py-1 rounded bg-gray-800 text-white"
            >
              Copy
            </button>
          </div>
        </div>

        <div className="p-4 border-b border-gray-300">
          <h2 className="text-xl font-bold mb-2">Users</h2>
          <ul>
            {users.map((user, index) => (
              <li key={index} className="p-2 bg-gray-800 text-white rounded mb-2">
                {user.username}
              </li>
            ))}
          </ul>
        </div>

        <div className="p-4 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xl font-bold">Files</h2>
            <label className={`text-xs px-3 py-1 rounded bg-gray-800 text-white cursor-pointer ${uploading ? "opacity-50" : ""}`}>
              {uploading ? "Uploading…" : "Upload"}
              <input
                type="file"
                className="hidden"
                accept="image/*,application/pdf,.doc,.docx"
                onChange={handleUpload}
                disabled={uploading}
              />
            </label>
          </div>

          {fileError && <p className="text-red-600 text-xs mb-2">{fileError}</p>}

          {files.length === 0 ? (
            <p className="text-gray-500 text-sm">No files yet. Upload an image, PDF or doc.</p>
          ) : (
            <ul>
              {files.map((f) => (
                <li key={f.id} className="mb-2">
                  <button
                    onClick={() => openFile(f.id)}
                    className="w-full text-left p-2 bg-gray-800 text-white rounded hover:bg-gray-700"
                  >
                    <span className="block truncate">{f.filename}</span>
                    <span className="block text-xs text-gray-400">
                      {formatSize(f.size)} · {f.uploadedBy}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <section className="w-3/4 bg-neutral-800 rounded-lg overflow-hidden flex flex-col">
        {/* Toolbar: pick a language and run the shared code. */}
        <div className="flex items-center gap-2 p-2 border-b border-neutral-700">
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="bg-neutral-700 text-white text-sm rounded px-2 py-1 outline-none"
          >
            {LANGUAGES.map((l) => (
              <option key={l.piston} value={l.piston}>{l.label}</option>
            ))}
          </select>
          <button
            onClick={handleRun}
            disabled={running}
            className="px-4 py-1 rounded bg-green-500 text-gray-950 text-sm font-bold disabled:opacity-50"
          >
            {running ? "Running…" : "▶ Run"}
          </button>
        </div>

        <div className="flex-1 min-h-0">
          <Editor
            height="100%"
            language={monacoLang}
            defaultValue="// some comment"
            theme="vs-dark"
            onMount={handleMount}
          />
        </div>

        {/* Output panel: only shown once there's a result to show. */}
        {output && (
          <div className="h-1/3 overflow-y-auto border-t border-neutral-700 p-3 font-mono text-sm">
            <div className="flex items-center justify-between mb-1">
              <span className="text-gray-400 text-xs uppercase tracking-wide">Output</span>
              <button onClick={() => setOutput(null)} className="text-gray-500 text-xs hover:text-white">clear</button>
            </div>
            {output.stdout && <pre className="text-green-300 whitespace-pre-wrap">{output.stdout}</pre>}
            {output.stderr && <pre className="text-red-400 whitespace-pre-wrap">{output.stderr}</pre>}
            {!output.stdout && !output.stderr && <pre className="text-gray-500">(no output)</pre>}
          </div>
        )}
      </section>
    </main>
  )
}

export default App
