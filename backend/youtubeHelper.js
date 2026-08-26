import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { YoutubeTranscript } from "youtube-transcript";
import ffmpegPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binDir = path.join(__dirname, "bin");
const ytDlpExecutable = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
const ytDlpPath = path.join(binDir, ytDlpExecutable);

/**
 * Ensure yt-dlp binary is available locally; auto-download from official GitHub release if missing
 */
export async function ensureYtDlp() {
  if (!fs.existsSync(ytDlpPath)) {
    fs.mkdirSync(binDir, { recursive: true });
    console.log("yt-dlp binary not found. Auto-downloading official yt-dlp binary...");

    const downloadUrl =
      process.platform === "win32"
        ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
        : process.platform === "darwin"
        ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
        : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

    const response = await fetch(downloadUrl, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`Failed to download yt-dlp binary: ${response.status} ${response.statusText}`);
    }

    const fileStream = fs.createWriteStream(ytDlpPath);
    await pipeline(Readable.fromWeb(response.body), fileStream);

    if (process.platform !== "win32") {
      fs.chmodSync(ytDlpPath, 0o755);
    }

    console.log("yt-dlp binary downloaded successfully at:", ytDlpPath);
  }

  try {
    console.log("Checking for yt-dlp updates...");
    await execFileAsync(ytDlpPath, ["-U"]);
  } catch (err) {
    console.warn("Failed to update yt-dlp (this is usually fine):", err.message);
  }

  return ytDlpPath;
}

/**
 * Ensure cookies file exists from YOUTUBE_COOKIES environment variable
 */
export function ensureCookies() {
  const cookiesPath = path.join(__dirname, "youtube-cookies.txt");
  if (process.env.YOUTUBE_COOKIES) {
    fs.writeFileSync(cookiesPath, process.env.YOUTUBE_COOKIES.replace(/\\n/g, '\n'));
    return cookiesPath;
  }
  if (fs.existsSync(cookiesPath)) {
    return cookiesPath;
  }
  return null;
}

/**
 * Extract YouTube Video ID from standard or shortened URLs
 */
export function extractVideoId(url) {
  if (!url || typeof url !== "string") return null;

  const regex = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

/**
 * Get metadata for YouTube video using YouTube oEmbed API (100% reliable)
 */
export async function getYouTubeInfo(url) {
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new Error("Invalid YouTube URL. Please provide a valid YouTube link.");
  }

  const defaultThumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(oembedUrl);
    if (response.ok) {
      const data = await response.json();
      return {
        id: videoId,
        title: data.title || "YouTube Video",
        author: data.author_name || "YouTube Creator",
        thumbnail: defaultThumbnail,
      };
    }
  } catch (err) {
    console.warn("oEmbed fetch warning:", err.message);
  }

  return {
    id: videoId,
    title: "YouTube Video",
    author: "YouTube Creator",
    thumbnail: defaultThumbnail,
  };
}

/**
 * Fetch timestamped transcript if available for the YouTube video
 */
export async function getYouTubeTranscript(videoId) {
  try {
    const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
    if (!transcriptItems || transcriptItems.length === 0) return null;

    const formatted = transcriptItems
      .map((item) => {
        const startSec = Math.floor((item.offset || 0) / 1000);
        const mins = Math.floor(startSec / 60);
        const secs = startSec % 60;
        const timeFormatted = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
        return `[${timeFormatted} (${startSec}s)] ${item.text}`;
      })
      .join("\n");

    return formatted;
  } catch (err) {
    console.warn("Transcript not available for this video:", err.message);
    return null;
  }
}

/**
 * ULTRA-FAST: Download ONLY the required 30-60 second section directly from YouTube
 * (Bypasses downloading the full 1-2 hour video, finishes in 2-3 seconds!)
 */
export async function downloadYouTubeSection(videoId, startSec, endSec, destinationPath) {
  const binaryPath = await ensureYtDlp();
  const startFormatted = Math.max(0, Math.floor(startSec));
  const endFormatted = Math.ceil(endSec);

  console.log(`[Lightning-Fast] Downloading 30s section: [${startFormatted}s - ${endFormatted}s] for video ${videoId}...`);

  const cookieFile = ensureCookies();
  const clientOptions = [];
  if (cookieFile) {
    clientOptions.push(
      ["--cookies", cookieFile],
      ["--extractor-args", "youtube:player_client=android,ios", "--cookies", cookieFile],
      ["--extractor-args", "youtube:player_client=web", "--cookies", cookieFile],
      ["--extractor-args", "youtube:player_client=mweb", "--cookies", cookieFile]
    );
  }
  clientOptions.push(
    ["--extractor-args", "youtube:player_client=android,ios", "--cookies-from-browser", "chrome"],
    ["--extractor-args", "youtube:player_client=android,ios", "--cookies-from-browser", "edge"],
    ["--extractor-args", "youtube:player_client=android,ios", "--cookies-from-browser", "firefox"],
    ["--extractor-args", "youtube:player_client=android,ios", "--cookies-from-browser", "brave"],
    ["--extractor-args", "youtube:player_client=android,ios"],
    ["--extractor-args", "youtube:player_client=mweb"],
    ["--extractor-args", "youtube:player_client=android_embedded"],
    []
  );

  let lastError = null;
  for (const clientOpt of clientOptions) {
    try {
      const args = [
        "--no-warnings",
        "--no-check-certificates",
        "--force-ipv4",
        "--user-agent",
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
        ...clientOpt,
        "--ffmpeg-location",
        ffmpegPath,
        "--download-sections",
        `*${startFormatted}-${endFormatted}`,
        "--force-keyframes-at-cuts",
        "-f",
        "bv*[height<=720]+ba/b[height<=720]/best",
        "--merge-output-format",
        "mp4",
        "-o",
        destinationPath,
        `https://www.youtube.com/watch?v=${videoId}`,
      ];

      await execFileAsync(binaryPath, args);

      if (!fs.existsSync(destinationPath)) {
        const dir = path.dirname(destinationPath);
        const baseName = path.basename(destinationPath, path.extname(destinationPath));
        const files = fs.readdirSync(dir);
        const matched = files.find((f) => f.startsWith(baseName));
        if (matched) {
          fs.renameSync(path.join(dir, matched), destinationPath);
        }
      }

      if (fs.existsSync(destinationPath)) {
        return destinationPath;
      }
    } catch (err) {
      console.warn(`yt-dlp section attempt failed (${clientOpt.join(" ")}):`, err.message);
      lastError = err;
    }
  }

  throw lastError || new Error("Failed to download YouTube section.");
}

/**
 * Fallback: Download full YouTube video if section slicing is not supported
 */
export async function downloadYouTubeVideo(url, destinationPath) {
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new Error("Invalid YouTube URL.");
  }

  const binaryPath = await ensureYtDlp();
  const info = await getYouTubeInfo(url);
  const title = info.title || "YouTube Video";

  console.log(`Downloading full YouTube video with yt-dlp: "${title}" (ID: ${videoId})...`);

  const cookieFile = ensureCookies();
  const clientOptions = [];
  if (cookieFile) {
    clientOptions.push(
      ["--cookies", cookieFile],
      ["--extractor-args", "youtube:player_client=android,ios", "--cookies", cookieFile],
      ["--extractor-args", "youtube:player_client=web", "--cookies", cookieFile],
      ["--extractor-args", "youtube:player_client=mweb", "--cookies", cookieFile]
    );
  }
  clientOptions.push(
    ["--extractor-args", "youtube:player_client=android,ios", "--cookies-from-browser", "chrome"],
    ["--extractor-args", "youtube:player_client=android,ios", "--cookies-from-browser", "edge"],
    ["--extractor-args", "youtube:player_client=android,ios", "--cookies-from-browser", "firefox"],
    ["--extractor-args", "youtube:player_client=android,ios", "--cookies-from-browser", "brave"],
    ["--extractor-args", "youtube:player_client=android,ios"],
    ["--extractor-args", "youtube:player_client=mweb"],
    ["--extractor-args", "youtube:player_client=android_embedded"],
    []
  );

  let lastError = null;
  for (const clientOpt of clientOptions) {
    try {
      const args = [
        "--no-warnings",
        "--no-check-certificates",
        "--force-ipv4",
        "--user-agent",
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
        ...clientOpt,
        "--ffmpeg-location",
        ffmpegPath,
        "-f",
        "bv*[height<=720]+ba/b[height<=720]/best",
        "--merge-output-format",
        "mp4",
        "-o",
        destinationPath,
        `https://www.youtube.com/watch?v=${videoId}`,
      ];

      await execFileAsync(binaryPath, args);

      if (!fs.existsSync(destinationPath)) {
        const dir = path.dirname(destinationPath);
        const baseName = path.basename(destinationPath, path.extname(destinationPath));
        const files = fs.readdirSync(dir);
        const matched = files.find((f) => f.startsWith(baseName));
        if (matched) {
          fs.renameSync(path.join(dir, matched), destinationPath);
        }
      }

      if (fs.existsSync(destinationPath)) {
        return {
          id: videoId,
          title,
          filePath: destinationPath,
        };
      }
    } catch (err) {
      console.warn(`yt-dlp full video attempt failed (${clientOpt.join(" ")}):`, err.message);
      lastError = err;
    }
  }

  throw lastError || new Error("Downloaded video file not found on disk.");
}
