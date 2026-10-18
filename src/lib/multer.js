"use strict";
/**
 * Upload config for the QRIS transfer proof (Region 2.1):
 * images only, max 2 MB, deterministic filenames under uploads/proof.
 */
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");

const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(process.cwd(), config.uploads.proofDir);
    require("fs").mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".png";
    cb(null, `proof-${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`);
  },
});

const proofUpload = multer({
  storage,
  limits: { fileSize: config.uploads.maxProofBytes },
  fileFilter(req, file, cb) {
    if (!ALLOWED.has(file.mimetype)) {
      return cb(new Error("FILE_TYPE: hanya PNG/JPG/WEBP yang diterima"));
    }
    cb(null, true);
  },
});

module.exports = { proofUpload };
