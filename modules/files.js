/**
 * Files module — file upload handling with S3, Sharp thumbnails, and path guards.
 */
const fs = require("fs").promises
const crypto = require("crypto")
const path = require("path")
const { run, get } = require("../database/db")
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3")
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner")
const sharp = require("sharp")
const Redis = require("ioredis")

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null
const s3 = process.env.S3_BUCKET ? new S3Client({ region: process.env.AWS_REGION || "us-east-1" }) : null
const BUCKET = process.env.S3_BUCKET

const UPLOADS_DIR = path.join(__dirname, "..", "uploads")
async function ensureUploadsDir() { try { await fs.mkdir(UPLOADS_DIR, { recursive: true }) } catch {} }

const MAX_FILE_SIZE = process.env.S3_BUCKET ? 100 * 1024 * 1024 : 10 * 1024 * 1024 // 100MB with S3, 10MB local
const ALLOWED_TYPES = [
  "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp",
  "application/pdf", "text/plain", "application/zip",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/octet-stream"
]

function validateFile(file) {
  if (file.size > MAX_FILE_SIZE) throw new Error("File too large")
  if (!ALLOWED_TYPES.includes(file.type)) throw new Error("Unsupported type")
}

function safeBasename(name) { return path.basename(String(name || "bin").replace(/\0/g, "")) }
function safeExt(name) {
  const ext = path.extname(safeBasename(name))
  return /^\.[a-zA-Z0-9]+$/.test(ext) ? ext : ".bin"
}

// Generate an S3 presigned URL for direct upload
async function getUploadPresignedUrl(filename, mimeType) {
  if (!s3) return null
  const command = new PutObjectCommand({ Bucket: BUCKET, Key: filename, ContentType: mimeType })
  return await getSignedUrl(s3, command, { expiresIn: 900 }) // 15 mins
}

// Generate an S3 presigned URL for download
async function getDownloadPresignedUrl(filename) {
  if (!s3) return null
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: filename })
  return await getSignedUrl(s3, command, { expiresIn: 900 })
}

// Generate thumbnail using Sharp
async function generateThumbnail(buffer) {
  try {
    return await sharp(buffer).resize({ width: 256, height: 256, fit: "inside" }).webp({ quality: 80 }).toBuffer()
  } catch (e) { return null }
}

async function saveFile(buffer, originalName) {
  const ext = safeExt(originalName)
  const filename = crypto.randomBytes(16).toString("hex") + ext
  
  if (s3) {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: filename, Body: buffer }))
    return { filename, filepath: null }
  } else {
    await ensureUploadsDir()
    const filepath = path.join(UPLOADS_DIR, filename)
    await fs.writeFile(filepath, buffer)
    return { filename, filepath }
  }
}

async function recordFile(senderId, receiverId, filename, originalName, fileSize, mimeType, encryptedMeta, timestamp) {
  const result = await run(
    `INSERT INTO files (sender_id, receiver_id, file_path, original_name, file_size, mime_type, encrypted_meta, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [senderId, receiverId, filename, originalName, fileSize, mimeType, encryptedMeta, timestamp]
  )
  return result.lastID
}

async function getFileUrl(filename) {
  if (s3) {
    try { return await getDownloadPresignedUrl(filename) } catch (e) { return "" }
  }
  return `/api/files/${encodeURIComponent(filename)}`
}

async function deleteFile(filename) {
  if (s3) {
    try {
      const { DeleteObjectCommand } = require("@aws-sdk/client-s3")
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: filename }))
    } catch (e) {}
  } else {
    const safe = safeBasename(filename)
    try { await fs.unlink(path.join(UPLOADS_DIR, safe)) } catch {}
  }
}

module.exports = { validateFile, saveFile, recordFile, getFileUrl, deleteFile, safeBasename, getUploadPresignedUrl, getDownloadPresignedUrl, generateThumbnail, MAX_FILE_SIZE, ALLOWED_TYPES, UPLOADS_DIR }
