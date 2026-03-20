import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import contentDisposition from "content-disposition";
import * as ftp from "basic-ftp";
import Throttle from "throttle";
import mime from "mime-types";

import { PassThrough } from "stream";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Helper to check if URL is FTP
  const isFtp = (url: string) => url.startsWith("ftp://");

  // API Route: Get file metadata
  app.get("/api/metadata", async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }

    try {
      if (isFtp(url)) {
        const client = new ftp.Client();
        const urlObj = new URL(url);
        try {
          await client.access({
            host: urlObj.hostname,
            user: urlObj.username || "anonymous",
            password: urlObj.password || "anonymous",
            port: parseInt(urlObj.port) || 21,
          });
          const list = await client.list(path.dirname(urlObj.pathname));
          const filename = path.basename(urlObj.pathname);
          const fileInfo = list.find(f => f.name === filename);
          
          if (!fileInfo) throw new Error("File not found on FTP server");

          const contentType = mime.lookup(filename) || "application/octet-stream";

          res.json({
            filename: fileInfo.name,
            contentType,
            contentLength: fileInfo.size,
            acceptRanges: true,
          });
        } finally {
          client.close();
        }
      } else {
        const response = await axios.head(url, {
          maxRedirects: 5,
          timeout: 5000,
        });

        let contentType = response.headers["content-type"];
        const contentLength = response.headers["content-length"];
        const acceptRanges = response.headers["accept-ranges"] === "bytes";
        const cd = response.headers["content-disposition"];
        let filename = "download";

        if (cd) {
          const parsed = contentDisposition.parse(cd);
          if (parsed.parameters && parsed.parameters.filename) {
            filename = parsed.parameters.filename;
          }
        } else {
          const urlObj = new URL(url);
          const pathSegments = urlObj.pathname.split("/");
          const lastSegment = pathSegments[pathSegments.length - 1];
          if (lastSegment) {
            filename = lastSegment;
          }
        }

        // If content-type is generic, try to refine it with filename
        if (!contentType || contentType === "application/octet-stream") {
          const refined = mime.lookup(filename);
          if (refined) contentType = refined;
        }

        res.json({
          filename,
          contentType,
          contentLength: contentLength ? parseInt(contentLength, 10) : null,
          acceptRanges,
        });
      }
    } catch (error: any) {
      console.error("Metadata error:", error.message);
      res.status(500).json({ error: "Failed to fetch metadata" });
    }
  });

  // API Route: Proxy Download with Range and Speed Limit support
  app.get("/api/download", async (req, res) => {
    const { url, filename, start, speedLimit } = req.query;
    if (!url || typeof url !== "string") {
      return res.status(400).send("URL is required");
    }

    const startByte = start ? parseInt(start as string, 10) : 0;
    const limit = speedLimit ? parseInt(speedLimit as string, 10) : 0; // in bytes per second

    try {
      if (isFtp(url)) {
        const client = new ftp.Client();
        const urlObj = new URL(url);
        try {
          await client.access({
            host: urlObj.hostname,
            user: urlObj.username || "anonymous",
            password: urlObj.password || "anonymous",
            port: parseInt(urlObj.port) || 21,
          });

          const safeFilename = (filename as string) || path.basename(urlObj.pathname) || "download";
          res.setHeader("Content-Disposition", contentDisposition(safeFilename));
          res.setHeader("Content-Type", "application/octet-stream");

          // FTP download from offset
          const passThrough = new PassThrough();
          client.downloadTo(passThrough, urlObj.pathname, startByte);
          
          let finalStream: any = passThrough;
          if (limit > 0) {
            finalStream = passThrough.pipe(new Throttle(limit));
          }
          
          finalStream.pipe(res);
          
          res.on("close", () => {
            client.close();
          });
        } catch (err) {
          client.close();
          throw err;
        }
      } else {
        const headers: any = {};
        if (startByte > 0) {
          headers["Range"] = `bytes=${startByte}-`;
        }

        const response = await axios({
          method: "get",
          url: url,
          responseType: "stream",
          timeout: 60000,
          headers,
        });

        if (startByte > 0) {
          res.status(206); // Partial Content
          res.setHeader("Content-Range", response.headers["content-range"]);
        }

        const contentType = response.headers["content-type"];
        const contentLength = response.headers["content-length"];
        
        if (contentType) res.setHeader("Content-Type", contentType);
        if (contentLength) res.setHeader("Content-Length", contentLength);
        
        const safeFilename = (filename as string) || "download";
        res.setHeader("Content-Disposition", contentDisposition(safeFilename));

        let finalStream = response.data;
        if (limit > 0) {
          finalStream = response.data.pipe(new Throttle(limit));
        }

        finalStream.pipe(res);
      }
    } catch (error: any) {
      console.error("Download error:", error.message);
      res.status(500).send("Failed to download file");
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
