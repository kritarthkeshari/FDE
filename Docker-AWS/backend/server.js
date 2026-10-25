import express from "express"
import { createServer } from "http"
import { Server } from "socket.io"
import { YSocketIO } from "y-socket.io/dist/server"
import { MongoClient, ObjectId } from "mongodb"
import { MongodbPersistence } from "y-mongodb-provider"
import * as Y from "yjs"
import multer from "multer"
import { randomUUID } from "crypto"
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadBucketCommand,
    CreateBucketCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"


// --- Config -----------------------------------------------------------------
// Everything environment-specific comes from env vars, so the SAME image runs
// locally (local Mongo + MinIO) and on AWS (Atlas + real S3) by changing vars.
const PORT = process.env.PORT || 3000
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017"
const DB_NAME = process.env.DB_NAME || "codetogether"

// S3 / object storage. In production S3_ENDPOINT is left UNSET: the AWS SDK then
// talks to real AWS S3 and picks up credentials from the ECS task's IAM role.
// Locally we point S3_ENDPOINT at MinIO and pass its credentials explicitly.
const S3_ENDPOINT = process.env.S3_ENDPOINT                    // e.g. http://127.0.0.1:9000 (MinIO); unset on AWS
const S3_REGION = process.env.S3_REGION || "us-east-1"
const S3_BUCKET = process.env.S3_BUCKET || "codetogether-uploads"
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY
const S3_SECRET_KEY = process.env.S3_SECRET_KEY
// Browser-facing endpoint used ONLY to sign download URLs. In docker-compose
// the app reaches MinIO at http://minio:9000 (service name, internal), but the
// browser must use http://localhost:9000 -- so we sign with this when set.
const S3_PUBLIC_ENDPOINT = process.env.S3_PUBLIC_ENDPOINT


// Short, shareable code. We drop 0/O/1/I so codes are easy to read aloud/type.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
function generateCode(length = 6) {
    let code = ""
    for (let i = 0; i < length; i++) {
        code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
    }
    return code
}

// Only these file types may be uploaded (your "image/pdf/doc" requirement).
const ALLOWED_TYPES = new Set([
    "image/png", "image/jpeg", "image/gif", "image/webp",
    "application/pdf",
    "application/msword",                                                       // .doc
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",  // .docx
])


// Retry a flaky startup step. In docker-compose the app can boot before Mongo
// or MinIO are ready, so we retry instead of crashing on the first attempt.
async function withRetry(fn, { tries = 15, delayMs = 2000, label = "" } = {}) {
    for (let i = 1; i <= tries; i++) {
        try {
            return await fn()
        } catch (e) {
            if (i === tries) throw e
            console.log(`[startup] ${label} not ready (attempt ${i}/${tries}) -- retrying in ${delayMs}ms`)
            await new Promise((r) => setTimeout(r, delayMs))
        }
    }
}


async function main() {
    // One MongoClient, shared by the collections AND the Yjs persistence.
    const client = new MongoClient(MONGO_URI)
    await withRetry(() => client.connect(), { label: "MongoDB" })
    const db = client.db(DB_NAME)
    const rooms = db.collection("rooms")
    const files = db.collection("files")
    await rooms.createIndex({ code: 1 }, { unique: true })
    await files.createIndex({ roomCode: 1, uploadedAt: -1 })   // fast "files in this room, newest first"
    console.log(`Connected to MongoDB (db: ${DB_NAME})`)

    // Persists each room's editor text as Yjs updates so it survives restarts.
    const persistence = new MongodbPersistence({ client, db }, {
        collectionName: "yjs-docs",
    })

    // S3 client. endpoint/forcePathStyle are only set for MinIO; on AWS we omit
    // them so the SDK uses the real S3 endpoints and virtual-hosted URLs.
    const s3Credentials = (S3_ACCESS_KEY && S3_SECRET_KEY)
        ? { credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY } }
        : {}

    // File uploads need S3. If S3 is unreachable or misconfigured at startup we
    // DISABLE uploads but keep the app running -- rooms, live editing and text
    // persistence still work. The file routes below return 503 while disabled.
    let filesEnabled = false
    let s3 = null
    let s3Presign = null
    try {
        // Client for real operations (upload, list) against S3/MinIO.
        s3 = new S3Client({
            region: S3_REGION,
            ...(S3_ENDPOINT ? { endpoint: S3_ENDPOINT, forcePathStyle: true } : {}),
            ...s3Credentials,
        })
        // Client used ONLY to sign download URLs. getSignedUrl makes no network
        // call -- it just bakes this endpoint into the URL -- so signing with the
        // public endpoint gives the browser a URL it can actually reach.
        s3Presign = S3_PUBLIC_ENDPOINT
            ? new S3Client({ region: S3_REGION, endpoint: S3_PUBLIC_ENDPOINT, forcePathStyle: true, ...s3Credentials })
            : s3

        // Make sure the bucket exists (handy for local MinIO; on AWS you'd
        // usually create it once via the console / IaC instead).
        await withRetry(async () => {
            try {
                await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }))
            } catch {
                await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }))
                console.log(`Created S3 bucket: ${S3_BUCKET}`)
            }
        }, { tries: 3, label: "S3" })

        filesEnabled = true
        console.log(`S3 ready (bucket: ${S3_BUCKET}) -- file uploads enabled`)
    } catch (e) {
        console.warn(`[startup] S3 unavailable -- file uploads DISABLED: ${e.message}`)
    }

    // Files arrive in memory (not written to disk), then stream straight to S3.
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 10 * 1024 * 1024 },   // 10 MB cap
        fileFilter: (req, file, cb) => cb(null, ALLOWED_TYPES.has(file.mimetype)),
    })

    const app = express()
    app.use(express.json())
    app.use(express.static("public"))

    // --- Rooms --------------------------------------------------------------
    app.post("/api/rooms", async (req, res) => {
        let code = generateCode()
        while (await rooms.findOne({ code })) code = generateCode()
        await rooms.insertOne({ code, createdAt: new Date() })
        res.status(201).json({ code })
    })

    app.get("/api/rooms/:code", async (req, res) => {
        const code = req.params.code.toUpperCase()
        const room = await rooms.findOne({ code })
        if (room) res.status(200).json({ code, exists: true })
        else res.status(404).json({ exists: false })
    })

    // --- Files (scoped to a room) -------------------------------------------
    // Upload one file into a room. The bytes go to S3; a metadata record
    // (which room, S3 key, name, type, who) goes to MongoDB.
    const requireFiles = (req, res, next) =>
        filesEnabled ? next() : res.status(503).json({ error: "File storage is not configured" })

    app.post("/api/rooms/:code/files", requireFiles, upload.single("file"), async (req, res) => {
        const code = req.params.code.toUpperCase()
        if (!(await rooms.findOne({ code }))) return res.status(404).json({ error: "No such room" })
        if (!req.file) return res.status(400).json({ error: "No file, or file type not allowed" })

        const key = `rooms/${code}/${randomUUID()}-${req.file.originalname}`
        await s3.send(new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
        }))

        const doc = {
            roomCode: code,
            key,
            filename: req.file.originalname,
            contentType: req.file.mimetype,
            size: req.file.size,
            uploadedBy: (req.body.username || "unknown").slice(0, 50),
            uploadedAt: new Date(),
        }
        const { insertedId } = await files.insertOne(doc)
        res.status(201).json({ id: insertedId, ...doc })
    })

    // List files in a room (newest first).
    app.get("/api/rooms/:code/files", requireFiles, async (req, res) => {
        const code = req.params.code.toUpperCase()
        const list = await files.find({ roomCode: code }).sort({ uploadedAt: -1 }).toArray()
        res.json(list.map((f) => ({ id: f._id, ...f })))
    })

    // Hand back a short-lived, signed download URL for one file. The client
    // never gets our S3 credentials -- just a URL that works for 5 minutes.
    app.get("/api/rooms/:code/files/:id/url", requireFiles, async (req, res) => {
        const code = req.params.code.toUpperCase()
        let doc
        try {
            doc = await files.findOne({ _id: new ObjectId(req.params.id), roomCode: code })
        } catch {
            return res.status(400).json({ error: "Bad file id" })
        }
        if (!doc) return res.status(404).json({ error: "File not found" })
        const url = await getSignedUrl(
            s3Presign,
            new GetObjectCommand({ Bucket: S3_BUCKET, Key: doc.key }),
            { expiresIn: 300 },
        )
        res.json({ url })
    })

    // --- Code execution (external API: Wandbox) -----------------------------
    // Proxy pattern: the browser calls US, we call the public Wandbox API, and
    // we return just the program's output. The browser never talks to Wandbox
    // directly -- same idea as our S3 routes keeping credentials server-side.
    //
    // (We originally targeted Piston, but its public API became whitelist-only
    // in 2026, so we switched to Wandbox -- a keyless public runner. A real
    // lesson in external APIs: they change their terms, and your proxy is the
    // one place you have to update when they do.)
    //
    // Wandbox identifies runtimes by a specific "compiler" id, so we map the
    // simple language name the UI sends to a known-good compiler here.
    const WANDBOX_COMPILERS = {
        javascript: "nodejs-20.17.0",
        typescript: "typescript-5.6.2",
        python: "cpython-3.13.8",
        "c++": "gcc-13.2.0",
        java: "openjdk-jdk-22+36",
        go: "go-1.23.2",
    }

    app.post("/api/run", async (req, res) => {
        const { language, code } = req.body
        if (!language || typeof code !== "string") {
            return res.status(400).json({ error: "language and code are required" })
        }
        const compiler = WANDBOX_COMPILERS[language]
        if (!compiler) {
            return res.status(400).json({ error: `Unsupported language: ${language}` })
        }

        try {
            const upstream = await fetch("https://wandbox.org/api/compile.json", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ compiler, code }),
                // Don't let a slow external call hang our request forever.
                signal: AbortSignal.timeout(20_000),
            })

            if (!upstream.ok) {
                // Turn their failure into a clean 502 ("bad upstream") for us.
                const text = await upstream.text()
                console.error("[run] Wandbox error:", upstream.status, text)
                return res.status(502).json({ error: "Code runner unavailable" })
            }

            // Wandbox returns program_output / program_error, plus a separate
            // compiler_error for compile-time failures. Normalise all of that
            // into the same { stdout, stderr, exitCode } shape the UI expects,
            // so the frontend never has to know which runner we use.
            const r = await upstream.json()
            res.json({
                stdout: r.program_output ?? "",
                stderr: [r.compiler_error, r.program_error].filter(Boolean).join("\n"),
                exitCode: r.status != null ? Number(r.status) : null,
            })
        } catch (e) {
            // Network failure, timeout, or bad JSON all land here.
            console.error("[run] failed:", e.message)
            res.status(502).json({ error: "Code runner unavailable" })
        }
    })

    app.get("/health", (req, res) => {
        res.status(200).json({ message: "ok", success: true })
    })

    // Turn multer/upload errors (e.g. file too big) into clean 400s.
    app.use((err, req, res, next) => {
        if (err) return res.status(400).json({ error: err.message })
        next()
    })

    const httpServer = createServer(app)
    const io = new Server(httpServer, {
        cors: { origin: "*", methods: ["GET", "POST"] },
    })

    const ySocketIO = new YSocketIO(io)
    ySocketIO.initialize()

    // Load a room's saved text from MongoDB when it opens, then save every edit.
    ySocketIO.on("document-loaded", async (doc) => {
        const stored = await persistence.getYDoc(doc.name)
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(stored), "mongodb-load")
        doc.on("update", (update, origin) => {
            if (origin === "mongodb-load") return
            persistence.storeUpdate(doc.name, update).catch((e) =>
                console.error("[persist] failed to store update:", e)
            )
        })
    })

    httpServer.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`)
    })
}

main().catch((err) => {
    console.error("Fatal startup error:", err)
    process.exit(1)
})
