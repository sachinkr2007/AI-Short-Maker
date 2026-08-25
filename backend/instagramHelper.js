import { IgApiClient } from "instagram-private-api";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import ffmpegPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sessionFilePath = path.join(__dirname, "session-instagram.json");
let igClient = null;

/**
 * Get or create Instagram client with persistent session cookies
 */
export function getInstagramClient() {
  if (!igClient) {
    igClient = new IgApiClient();
  }
  return igClient;
}

/**
 * Login to Instagram and save session locally (OTP is ONLY needed on first login!)
 */
export async function loginInstagram(username, password) {
  const ig = getInstagramClient();
  const cleanUsername = username.trim().replace(/^@/, "");

  ig.state.generateDevice(cleanUsername);

  console.log(`[Instagram Auth] Authenticating user: ${cleanUsername}...`);

  try {
    const auth = await ig.account.login(cleanUsername, password);

    // Save session state to disk so future uploads NEVER ask for login/OTP again!
    const serializedSession = await ig.state.serialize();
    fs.writeFileSync(sessionFilePath, JSON.stringify(serializedSession, null, 2));

    console.log(`[Instagram Auth] Login successful! Session saved for @${cleanUsername}.`);

    return {
      success: true,
      user: {
        pk: auth.pk,
        username: auth.username,
        fullName: auth.full_name,
        profilePicUrl: auth.profile_pic_url,
      },
    };
  } catch (error) {
    console.error("[Instagram Auth Error]:", error);

    if (error.name === "IgCheckpointError") {
      throw new Error(
        "Instagram security checkpoint triggered! Please open the Instagram app on your phone once to tap 'This Was Me', then try again."
      );
    }

    if (error.name === "IgLoginTwoFactorRequiredError") {
      throw new Error(
        "Two-factor authentication (2FA) is enabled on this account. Please provide your 2FA security code."
      );
    }

    throw new Error(error.message || "Invalid Instagram username or password.");
  }
}

/**
 * Check if a saved active Instagram session exists
 */
export async function getSavedInstagramSession() {
  if (!fs.existsSync(sessionFilePath)) {
    return null;
  }

  try {
    const ig = getInstagramClient();
    const sessionData = JSON.parse(fs.readFileSync(sessionFilePath, "utf8"));
    await ig.state.deserialize(sessionData);

    const currentUser = await ig.account.currentUser();
    return {
      pk: currentUser.pk,
      username: currentUser.username,
      fullName: currentUser.full_name,
      profilePicUrl: currentUser.profile_pic_url,
    };
  } catch (e) {
    console.warn("Saved Instagram session expired or invalid:", e.message);
    return null;
  }
}

/**
 * Logout and clear saved session
 */
export function logoutInstagram() {
  if (fs.existsSync(sessionFilePath)) {
    fs.unlinkSync(sessionFilePath);
  }
  igClient = null;
  return { success: true };
}

/**
 * REAL REELS UPLOADER: Upload short video directly to user's Instagram Reels feed!
 */
export async function publishInstagramReel(videoFilePath, caption = "") {
  const ig = getInstagramClient();

  // Restore saved session if not in memory
  if (!fs.existsSync(sessionFilePath)) {
    throw new Error("No active Instagram session found. Please link your Instagram account first.");
  }

  try {
    const sessionData = JSON.parse(fs.readFileSync(sessionFilePath, "utf8"));
    await ig.state.deserialize(sessionData);
  } catch (e) {
    console.warn("Deserializing session warning:", e.message);
  }

  if (!fs.existsSync(videoFilePath)) {
    throw new Error("Video file to publish not found on disk.");
  }

  console.log(`[Instagram Publish] Preparing Reel upload for: ${videoFilePath}...`);

  // Normalize video into Instagram's strict YUV420P H264 30fps format to avoid 412 Precondition Failed
  const tempCompliantPath = path.join(__dirname, "uploads", `ig-compliant-${Date.now()}.mp4`);
  const coverPath = path.join(__dirname, "uploads", `cover-${Date.now()}.jpg`);

  try {
    await execFileAsync(ffmpegPath, [
      "-y",
      "-i",
      videoFilePath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "main",
      "-r",
      "30",
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
      tempCompliantPath,
    ]);

    // Extract valid JPEG cover thumbnail
    await execFileAsync(ffmpegPath, [
      "-y",
      "-i",
      tempCompliantPath,
      "-ss",
      "00:00:01",
      "-vframes",
      "1",
      "-q:v",
      "2",
      coverPath,
    ]);

    const videoBuffer = fs.readFileSync(tempCompliantPath);
    const coverBuffer = fs.existsSync(coverPath)
      ? fs.readFileSync(coverPath)
      : Buffer.alloc(100);

    console.log(`[Instagram Publish] Uploading verified Reel (${(videoBuffer.length / (1024 * 1024)).toFixed(1)} MB)...`);

    // Publish video Reel
    const publishResult = await ig.publish.video({
      video: videoBuffer,
      coverImage: coverBuffer,
      caption: caption,
    });

    console.log("[Instagram Publish] ✅ Reel published successfully! Status:", publishResult?.status);

    return {
      success: true,
      mediaId: publishResult?.media?.id || publishResult?.id,
      code: publishResult?.media?.code,
      postUrl: publishResult?.media?.code ? `https://instagram.com/reel/${publishResult.media.code}/` : "https://instagram.com",
    };
  } finally {
    // Clean up temporary conversion files
    if (fs.existsSync(tempCompliantPath)) fs.unlink(tempCompliantPath, () => {});
    if (fs.existsSync(coverPath)) fs.unlink(coverPath, () => {});
  }
}
