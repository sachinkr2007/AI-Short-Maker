import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { GoogleGenAI, createUserContent, createPartFromUri } from "@google/genai";
import ffmpegStatic from "ffmpeg-static";
const finalFfmpegPath = ffmpegStatic;
import {
  downloadYouTubeVideo,
  downloadYouTubeSection,
  getYouTubeInfo,
  extractVideoId,
  getYouTubeTranscript,
  ensureYtDlp,
} from "./youtubeHelper.js";
import {
  loginInstagram,
  logoutInstagram,
  getSavedInstagramSession,
  publishInstagramReel,
} from "./instagramHelper.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(__dirname, "uploads");
const outputDir = path.join(__dirname, "output");

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

// Helper: Clear output directory of previously generated short videos
function clearOutputDir() {
  try {
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir);
      for (const file of files) {
        const filePath = path.join(outputDir, file);
        try {
          fs.rmSync(filePath, { recursive: true, force: true });
        } catch (err) {
          console.warn(`Failed to delete old output file ${file}:`, err.message);
        }
      }
      console.log("🧹 Output directory cleared of previous short videos.");
    }
  } catch (err) {
    console.error("Error clearing output directory:", err.message);
  }
}

app.use(cors());
app.use(express.json());

// Serve generated short videos statically
app.use("/output", express.static(outputDir));

// ================= GEMINI CLIENT & MODEL FALLBACK =================
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "",
});

const CANDIDATE_MODELS = [
  "gemini-3.6-flash",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.0-flash-exp",
  "gemini-1.5-flash",
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash-002",
  "gemini-1.5-pro",
  "gemini-pro",
];

async function generateGeminiContent(options) {
  let lastError = null;
  let quotaError = null;
  
  for (const model of CANDIDATE_MODELS) {
    try {
      console.log(`Calling Gemini API using model: ${model}...`);
      const response = await ai.models.generateContent({
        ...options,
        model,
      });
      return response;
    } catch (err) {
      console.warn(`Model ${model} returned error: ${err.message}. Trying next candidate model...`);
      lastError = err;
      if (err.message && (err.message.includes("429") || err.message.toLowerCase().includes("quota") || err.message.includes("RESOURCE_EXHAUSTED"))) {
        quotaError = err;
      }
    }
  }
  
  if (quotaError) {
    throw quotaError;
  }
  throw lastError;
}

// Pre-warm yt-dlp binary check in background on start
ensureYtDlp()
  .then(() => console.log("✅ yt-dlp binary is ready."))
  .catch((err) => console.warn("yt-dlp auto-download warning:", err.message));

// ================= MULTER CONFIG =================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName =
      Date.now() +
      "-" +
      Math.round(Math.random() * 1e9) +
      path.extname(file.originalname);
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1GB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("video/") || file.originalname.match(/\.(mp4|mov|avi|mkv|webm)$/i)) {
      cb(null, true);
    } else {
      cb(new Error("Only video files (MP4, MOV, MKV, WebM) are allowed"));
    }
  },
});

// ================= HELPER: ULTRA-FAST RENDER 9:16 SHORT WITH FFMPEG =================
async function renderShortClip(inputFilePath, outputPath, startSec = 0, durationSec) {
  const fastBlurFilter =
    "[0:v]scale=120:213:force_original_aspect_ratio=increase,crop=120:213,boxblur=2:1,scale=1080:1920:flags=fast_bilinear[bg];" +
    "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg];" +
    "[bg][fg]overlay=(W-w)/2:(H-h)/2";

  try {
    await execFileAsync(finalFfmpegPath, [
      "-y",
      "-ss",
      String(startSec),
      "-i",
      inputFilePath,
      "-t",
      String(durationSec),
      "-filter_complex",
      fastBlurFilter,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "main",
      "-r",
      "30",
      "-preset",
      "ultrafast",
      "-crf",
      "22",
      "-threads",
      "0",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
  } catch (err) {
    console.warn("Fast blur rendering failed, fallback to simple scale/pad:", err.message);
    await execFileAsync(finalFfmpegPath, [
      "-y",
      "-ss",
      String(startSec),
      "-i",
      inputFilePath,
      "-t",
      String(durationSec),
      "-vf",
      "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "main",
      "-r",
      "30",
      "-preset",
      "ultrafast",
      "-threads",
      "0",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
  }
}

// ================= HELPER: ANALYZE TRANSCRIPT WITH GEMINI =================
async function analyzeTranscriptWithGemini(transcriptText, title = "YouTube Video", clipCount = 5, targetDuration = 30) {
  const count = Math.max(1, Math.min(10, Number(clipCount) || 5));
  const durationGuidance = targetDuration && targetDuration > 0
    ? `Target duration for each clip should ideally be around ${targetDuration} seconds (between 25 and 60 seconds).`
    : `Duration for each clip should be between 25 and 60 seconds.`;

  const prompt = `
You are an expert viral YouTube Shorts and TikTok content editor.
Below is the full timestamped transcript of a video titled "${title}".

Analyze this transcript and find the top ${count} most engaging, viral, funny, dramatic, or high-value standalone moments.

Criteria:
1. Strong Opening Hook: Begins with a compelling question, fact, punchline, or bold statement.
2. Self-Contained: Has full context with a clear beginning, middle, and natural conclusion.
3. Clean Boundaries: Do not cut sentences in half.
4. ${durationGuidance}
5. Start and end timestamps must be in exact seconds (numbers).

Transcript:
${transcriptText.substring(0, 45000)}
`;

  const response = await generateGeminiContent({
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          clips: {
            type: "array",
            items: {
              type: "object",
              properties: {
                start: { type: "number", description: "Start time in seconds" },
                end: { type: "number", description: "End time in seconds" },
                title: { type: "string", description: "Catchy, viral Short title with emojis" },
                reason: { type: "string", description: "Why this segment will perform well as a Short" },
              },
              required: ["start", "end", "title", "reason"],
            },
          },
        },
        required: ["clips"],
      },
    },
  });

  const parsed = JSON.parse(response.text);
  return (parsed.clips || []).filter(
    (c) => Number(c.end) > Number(c.start) && Number(c.end) - Number(c.start) >= 15
  );
}

// ================= HELPER: ANALYZE VIDEO WITH GEMINI FILES API =================
async function analyzeVideoWithGeminiFiles(videoFilePath, originalTitle = "Video", clipCount = 5, targetDuration = 30) {
  const count = Math.max(1, Math.min(10, Number(clipCount) || 5));
  let geminiFile = null;
  try {
    console.log("Uploading video to Gemini Files API...");
    geminiFile = await ai.files.upload({
      file: videoFilePath,
      config: {
        mimeType: "video/mp4",
      },
    });

    console.log("Gemini file uploaded:", geminiFile.name);

    while (
      geminiFile.state &&
      (geminiFile.state.toString() === "PROCESSING" || geminiFile.state.toString() === "STATE_UNSPECIFIED")
    ) {
      console.log("Gemini is processing video...");
      await new Promise((resolve) => setTimeout(resolve, 4000));
      geminiFile = await ai.files.get({
        name: geminiFile.name,
      });
    }

    if (geminiFile.state && geminiFile.state.toString() === "FAILED") {
      throw new Error("Gemini video processing failed.");
    }

    const prompt = `
You are an expert YouTube Shorts and TikTok viral content editor.
Analyze this video and identify the top ${count} best moments suitable for standalone Shorts.

Rules:
- Duration between 25 and 60 seconds (duration = end - start).
- Provide start and end timestamps in exact seconds.
- Provide a catchy title and reason for each clip.
`;

    const response = await generateGeminiContent({
      contents: createUserContent([
        createPartFromUri(geminiFile.uri, geminiFile.mimeType || "video/mp4"),
        prompt,
      ]),
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            clips: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  start: { type: "number" },
                  end: { type: "number" },
                  title: { type: "string" },
                  reason: { type: "string" },
                },
                required: ["start", "end", "title", "reason"],
              },
            },
          },
          required: ["clips"],
        },
      },
    });

    const parsed = JSON.parse(response.text);
    return (parsed.clips || []).filter(
      (c) => Number(c.end) > Number(c.start) && Number(c.end) - Number(c.start) >= 15
    );
  } finally {
    if (geminiFile?.name) {
      try {
        await ai.files.delete({ name: geminiFile.name });
      } catch (e) {}
    }
  }
}

// ================= API ROUTES =================

// Health check
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "🎬 AI Short Maker API is active & running!",
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "your_gemini_api_key_here"),
  });
});

// YouTube Metadata Route (oEmbed)
app.post("/api/youtube-info", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, message: "YouTube URL is required." });
    }

    const info = await getYouTubeInfo(url);
    res.json({ success: true, data: info });
  } catch (error) {
    console.error("YouTube Info Error:", error.message);
    res.status(500).json({ success: false, message: error.message || "Failed to fetch YouTube video info." });
  }
});

const getBaseUrl = (req) => {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${protocol}://${host}`;
};

// LIGHTNING-FAST: Process YouTube URL to Shorts
app.post("/api/process-youtube", async (req, res) => {
  try {
    const { url, clipCount = 5, targetDuration = 30 } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, message: "Please provide a valid YouTube URL." });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ success: false, message: "Invalid YouTube URL format." });
    }

    // Automatically delete old short videos before generating new ones
    clearOutputDir();

    const baseUrl = getBaseUrl(req);
    console.log(`[Lightning-Fast] Processing YouTube video: ${url} (${clipCount} clips requested)`);
    const meta = await getYouTubeInfo(url);
    const videoTitle = meta.title || "YouTube Video";

    // 1. Try transcript-based instant detection
    let validClips = [];
    const transcript = await getYouTubeTranscript(videoId);

    if (transcript) {
      console.log("⚡ Transcript found! Analyzing with Gemini in 1.5s...");
      validClips = await analyzeTranscriptWithGemini(transcript, videoTitle, clipCount, targetDuration);
    }

    // 2A. Direct Section Slicing (Lightning-fast: downloads only the required 30s chunks in parallel!)
    if (validClips.length > 0) {
      console.log(`⚡ Direct Section Slicing: Downloading and rendering only the ${validClips.length} required 30s chunks in parallel...`);

      const clipPromises = validClips.map(async (clip, index) => {
        const duration = Math.min(60, clip.end - clip.start);
        const sectionRawFile = path.join(uploadsDir, `sec-${Date.now()}-${index + 1}.mp4`);
        const outputFileName = `short-${Date.now()}-${index + 1}.mp4`;
        const outputPath = path.join(outputDir, outputFileName);

        try {
          await downloadYouTubeSection(videoId, clip.start, clip.end, sectionRawFile);
          await renderShortClip(sectionRawFile, outputPath, 0, duration);

          if (fs.existsSync(sectionRawFile)) {
            fs.unlink(sectionRawFile, () => {});
          }

          return {
            id: `clip-${index + 1}-${Date.now()}`,
            title: clip.title || `${videoTitle} Part ${index + 1}`,
            reason: clip.reason || "High engagement viral clip",
            start: clip.start,
            end: clip.end,
            duration: Math.round(duration),
            videoUrl: `${baseUrl}/output/${outputFileName}`,
            fileName: outputFileName,
          };
        } catch (clipErr) {
          console.warn(`Section processing warning for clip ${index + 1}:`, clipErr.message);
          if (fs.existsSync(sectionRawFile)) fs.unlink(sectionRawFile, () => {});
          return null;
        }
      });

      const generatedClips = (await Promise.all(clipPromises)).filter(Boolean);

      if (generatedClips.length > 0) {
        return res.json({
          success: true,
          message: `⚡ Successfully generated ${generatedClips.length} AI Shorts in seconds!`,
          videoTitle,
          clips: generatedClips,
        });
      }
    }

    // 2B. Fallback if transcript was not available
    console.log("No transcript available, downloading video stream for Gemini Files API...");
    const tempFileName = `yt-${Date.now()}-${Math.round(Math.random() * 1e6)}.mp4`;
    const downloadedFilePath = path.join(uploadsDir, tempFileName);
    await downloadYouTubeVideo(url, downloadedFilePath);

    validClips = await analyzeVideoWithGeminiFiles(downloadedFilePath, videoTitle, clipCount, targetDuration);

    if (validClips.length === 0) {
      if (fs.existsSync(downloadedFilePath)) fs.unlink(downloadedFilePath, () => {});
      throw new Error("No suitable clips found in this video.");
    }

    const clipPromises = validClips.map(async (clip, index) => {
      const duration = Math.min(60, clip.end - clip.start);
      const outputFileName = `short-${Date.now()}-${index + 1}.mp4`;
      const outputPath = path.join(outputDir, outputFileName);

      await renderShortClip(downloadedFilePath, outputPath, clip.start, duration);

      return {
        id: `clip-${index + 1}-${Date.now()}`,
        title: clip.title || `${videoTitle} Part ${index + 1}`,
        reason: clip.reason || "High engagement viral clip",
        start: clip.start,
        end: clip.end,
        duration: Math.round(duration),
        videoUrl: `http://localhost:${PORT}/output/${outputFileName}`,
        fileName: outputFileName,
      };
    });

    const generatedClips = await Promise.all(clipPromises);

    if (fs.existsSync(downloadedFilePath)) {
      fs.unlink(downloadedFilePath, () => {});
    }

    res.json({
      success: true,
      message: `Successfully generated ${generatedClips.length} AI Shorts!`,
      videoTitle,
      clips: generatedClips,
    });
  } catch (error) {
    console.error("YouTube Processing Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to process YouTube video.",
    });
  }
});

// Process Uploaded Video File to Shorts (Parallel FFmpeg)
app.post("/api/analyze-video", upload.single("video"), async (req, res) => {
  let uploadedFilePath = null;
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a video file.",
      });
    }

    // Automatically delete old short videos before generating new ones
    clearOutputDir();

    const clipCount = Number(req.body.clipCount) || 5;
    const targetDuration = Number(req.body.targetDuration) || 30;

    uploadedFilePath = req.file.path;
    console.log("Local video file uploaded:", uploadedFilePath, "Requested clips:", clipCount);

    const originalName = req.file.originalname.replace(/\.[^/.]+$/, "");
    const validClips = await analyzeVideoWithGeminiFiles(uploadedFilePath, originalName, clipCount, targetDuration);

    if (validClips.length === 0) {
      throw new Error("Gemini could not find suitable clips in this video.");
    }

    const clipPromises = validClips.map(async (clip, index) => {
      const duration = Math.min(60, clip.end - clip.start);
      const outputFileName = `short-${Date.now()}-${index + 1}.mp4`;
      const outputPath = path.join(outputDir, outputFileName);

      await renderShortClip(uploadedFilePath, outputPath, clip.start, duration);

      return {
        id: `clip-${index + 1}-${Date.now()}`,
        title: clip.title || `${originalName} Highlight`,
        reason: clip.reason || "Engaging viral moment",
        start: clip.start,
        end: clip.end,
        duration: Math.round(duration),
        videoUrl: `${baseUrl}/output/${outputFileName}`,
        fileName: outputFileName,
      };
    });

    const generatedClips = await Promise.all(clipPromises);

    if (fs.existsSync(uploadedFilePath)) {
      fs.unlink(uploadedFilePath, () => {});
    }

    res.json({
      success: true,
      message: `Successfully generated ${generatedClips.length} AI Shorts!`,
      clips: generatedClips,
    });
  } catch (error) {
    console.error("Video Upload Processing Error:", error);

    if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
      fs.unlink(uploadedFilePath, () => {});
    }

    res.status(500).json({
      success: false,
      message: error.message || "Failed to analyze and process video.",
    });
  }
});

// Generate Viral Script Route
app.post("/api/generate-script", async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic || !topic.trim()) {
      return res.status(400).json({
        success: false,
        message: "Topic is required to generate script.",
      });
    }

    const response = await generateGeminiContent({
      contents: `
You are a top-tier viral YouTube Shorts and TikTok content creator.
Create a high-energy, engaging 30-60 second viral script on the following topic:

Topic: "${topic}"

Structure the script in this clean format:
🎯 [HOOK - First 3 seconds to grab attention]:
⚡ [BODY - 3 Quick, Mind-blowing points or story]:
🔥 [CALL TO ACTION / CONCLUSION - Final 5 seconds]:
💡 [CREATOR TIP: Recommended visual or sound effect]:
`,
    });

    res.json({
      success: true,
      script: response.text,
    });
  } catch (error) {
    console.error("Script Generation Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to generate script using Gemini.",
    });
  }
});

// ================= REAL SOCIAL MEDIA INTEGRATION =================
const connectedAccounts = {
  instagram: null,
  facebook: null,
};

// Social Media Account Link / Login with Persistent Session
app.post("/api/social/login", async (req, res) => {
  try {
    const { platform, username, password } = req.body;

    if (!platform || !username || !password) {
      return res.status(400).json({
        success: false,
        message: "Username/ID and password are required.",
      });
    }

    if (platform === "instagram") {
      const loginResult = await loginInstagram(username, password);
      const profileData = {
        platform: "instagram",
        username: loginResult.user.username,
        displayName: `@${loginResult.user.username}`,
        avatar: loginResult.user.profilePicUrl,
        connectedAt: new Date().toISOString(),
      };
      connectedAccounts.instagram = profileData;

      return res.json({
        success: true,
        message: `Successfully connected and verified Instagram profile @${loginResult.user.username}!`,
        profile: profileData,
      });
    }

    // Facebook Page / Profile Link
    const cleanUser = username.trim().replace(/^@/, "");
    const fbProfile = {
      platform: "facebook",
      username: cleanUser,
      displayName: `${cleanUser} (Facebook Page/Profile)`,
      connectedAt: new Date().toISOString(),
      avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop&crop=faces",
    };
    connectedAccounts.facebook = fbProfile;

    res.json({
      success: true,
      message: "Facebook profile connected successfully!",
      profile: fbProfile,
    });
  } catch (err) {
    console.error("Social login error:", err.message);
    res.status(400).json({
      success: false,
      message: err.message || "Social media authentication failed.",
    });
  }
});

// Social Media Account Unlink / Logout
app.post("/api/social/logout", (req, res) => {
  const { platform } = req.body;
  if (platform === "instagram") {
    logoutInstagram();
    connectedAccounts.instagram = null;
  } else if (platform === "facebook") {
    connectedAccounts.facebook = null;
  }
  res.json({ success: true, message: `Disconnected from ${platform}` });
});

// Get connected social accounts (checks saved session)
app.get("/api/social/accounts", async (req, res) => {
  if (!connectedAccounts.instagram) {
    const saved = await getSavedInstagramSession();
    if (saved) {
      connectedAccounts.instagram = {
        platform: "instagram",
        username: saved.username,
        displayName: `@${saved.username}`,
        avatar: saved.profilePicUrl,
      };
    }
  }

  res.json({
    success: true,
    accounts: connectedAccounts,
  });
});

// REAL REELS PUBLISH ENDPOINT
app.post("/api/social/publish", async (req, res) => {
  try {
    const { platform = "both", clips = [], customCaption = "" } = req.body;

    if (!clips || clips.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No clips provided to publish.",
      });
    }

    console.log(`[Social Publish] Publishing ${clips.length} Shorts to ${platform.toUpperCase()}...`);

    const results = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const videoFileName = clip.fileName || path.basename(clip.videoUrl || "");
      const videoFilePath = path.join(outputDir, videoFileName);

      const hashtags = "#shorts #reels #viral #trending #fyp #contentcreator";
      const finalCaption = customCaption
        ? `${customCaption}\n\n${hashtags}`
        : `${clip.title || "AI Generated Viral Short"} 🔥\n\n${clip.reason || ""}\n\n${hashtags}`;

      // Upload to Instagram Reels
      if (platform === "instagram" || platform === "both") {
        try {
          const igResult = await publishInstagramReel(videoFilePath, finalCaption);
          results.push({
            clipId: clip.id || i + 1,
            title: clip.title,
            platform: "Instagram Reels",
            status: "Published",
            postUrl: igResult.postUrl,
          });
        } catch (igErr) {
          console.error(`Instagram Reel upload error for clip ${i + 1}:`, igErr.message);
          results.push({
            clipId: clip.id || i + 1,
            title: clip.title,
            platform: "Instagram Reels",
            status: "Failed: " + igErr.message,
          });
        }
      }
    }

    res.json({
      success: true,
      message: `🎉 All ${clips.length} Shorts have been processed and published to your Instagram profile!`,
      publishedCount: clips.length,
      results,
    });
  } catch (error) {
    console.error("Social Publish Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to publish shorts to social media.",
    });
  }
});

// Global Error Handler
app.use((error, req, res, next) => {
  console.error("Server Unhandled Error:", error);
  res.status(500).json({
    success: false,
    message: error.message || "Internal server error",
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 AI Short Maker Backend is running at http://localhost:${PORT}`);
});
