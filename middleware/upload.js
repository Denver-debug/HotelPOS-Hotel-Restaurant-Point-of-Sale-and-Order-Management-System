// Product image upload, following the XianFire upload-middleware template.
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { AppError } from "../utils/http.js";
import { config } from "../config/env.js";

const uploadDir = path.join(config.rootDir, "public", "uploads", "products");

fs.mkdirSync(uploadDir, { recursive: true });

const allowedTypes = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const extension = allowedTypes[file.mimetype];

    cb(null, crypto.randomUUID() + extension);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 2 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    if (!allowedTypes[file.mimetype]) {
      return cb(new AppError("Unsupported image format. Use JPG, PNG or WebP.", 422));
    }

    cb(null, true);
  },
});

// Single optional image field; converts multer errors into form-friendly 422 errors.
export const productImage = (req, res, next) =>
  upload.single("image")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return next(new AppError(err.code === "LIMIT_FILE_SIZE" ? "Images must be 2 MB or smaller." : err.message, 422));
    }
    next(err);
  });
