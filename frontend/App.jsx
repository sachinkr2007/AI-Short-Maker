import { useState, useEffect } from "react";
import "./App.css";

const API_BASE = import.meta.env.VITE_API_BASE || "https://ai-short-maker.onrender.com";

function App() {
  const [activeTab, setActiveTab] = useState("youtube"); // 'youtube' | 'upload' | 'script'
  
  // Custom Controls (Clip count & duration)
  const [clipCount, setClipCount] = useState(5); // Default 5 shorts
  const [targetDuration, setTargetDuration] = useState(30); // Default 30s

  // YouTube State
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [videoInfo, setVideoInfo] = useState(null);
  const [fetchingInfo, setFetchingInfo] = useState(false);

  // Upload State
  const [selectedFile, setSelectedFile] = useState(null);

  // Script Generator State
  const [topic, setTopic] = useState("");
  const [script, setScript] = useState("");
  const [loadingScript, setLoadingScript] = useState(false);
  const [scriptCopied, setScriptCopied] = useState(false);

  // Processing & Results State
  const [processing, setProcessing] = useState(false);
  const [currentStep, setCurrentStep] = useState(0); // 1: Download/Upload, 2: AI Analyze, 3: FFmpeg Cut
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [clips, setClips] = useState([]);
  const [serverOnline, setServerOnline] = useState(null);

  // Social Share Notification State
  const [socialToast, setSocialToast] = useState("");
  const [customCaption, setCustomCaption] = useState("");

  // Check backend server status on mount
  useEffect(() => {
    fetch(`${API_BASE}/`)
      .then((res) => res.json())
      .then((data) => {
        setServerOnline(data.success);
      })
      .catch(() => {
        setServerOnline(false);
      });
  }, []);

  // Fetch YouTube metadata preview safely
  const handleFetchYoutubeInfo = async (url) => {
    if (!url || !url.trim()) return;
    setFetchingInfo(true);
    try {
      const res = await fetch(`${API_BASE}/api/youtube-info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (data.success && data.data) {
        setVideoInfo(data.data);
      }
    } catch (err) {
      console.warn("Could not load preview info:", err);
    } finally {
      setFetchingInfo(false);
    }
  };

  // Generate Shorts from YouTube
  const handleGenerateFromYoutube = async (e) => {
    e?.preventDefault();
    if (!youtubeUrl.trim()) {
      setErrorMessage("Please enter a valid YouTube video URL.");
      return;
    }

    setProcessing(true);
    setClips([]);
    setErrorMessage("");
    setSocialToast("");
    setCurrentStep(1);
    setStatusMessage("Downloading 30s video sections directly...");

    const stepTimer1 = setTimeout(() => {
      setCurrentStep(2);
      setStatusMessage(`Gemini AI is analyzing video for top ${clipCount} viral moments...`);
    }, 2000);

    const stepTimer2 = setTimeout(() => {
      setCurrentStep(3);
      setStatusMessage("FFmpeg is rendering ultra-fast 9:16 vertical Shorts in parallel...");
    }, 6000);

    try {
      const response = await fetch(`${API_BASE}/api/process-youtube`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: youtubeUrl.trim(),
          clipCount: Number(clipCount),
          targetDuration: Number(targetDuration),
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Failed to process YouTube video.");
      }

      setClips(data.clips || []);
      setCurrentStep(4);
      setStatusMessage(`✨ Generated ${data.clips?.length || 0} Shorts successfully!`);
    } catch (err) {
      console.error(err);
      setErrorMessage(err.message || "Something went wrong while creating Shorts.");
      setCurrentStep(0);
    } finally {
      clearTimeout(stepTimer1);
      clearTimeout(stepTimer2);
      setProcessing(false);
    }
  };

  // Generate Shorts from Uploaded Video File
  const handleGenerateFromUpload = async (e) => {
    e?.preventDefault();
    if (!selectedFile) {
      setErrorMessage("Please select a video file first.");
      return;
    }

    setProcessing(true);
    setClips([]);
    setErrorMessage("");
    setSocialToast("");
    setCurrentStep(1);
    setStatusMessage("Uploading video to server...");

    const stepTimer1 = setTimeout(() => {
      setCurrentStep(2);
      setStatusMessage(`Gemini AI is finding top ${clipCount} viral moments...`);
    }, 2500);

    const stepTimer2 = setTimeout(() => {
      setCurrentStep(3);
      setStatusMessage("Rendering 9:16 vertical Shorts in parallel with FFmpeg...");
    }, 6500);

    try {
      const formData = new FormData();
      formData.append("video", selectedFile);
      formData.append("clipCount", String(clipCount));
      formData.append("targetDuration", String(targetDuration));

      const response = await fetch(`${API_BASE}/api/analyze-video`, {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || "Failed to process uploaded video.");
      }

      setClips(data.clips || []);
      setCurrentStep(4);
      setStatusMessage(`✨ Generated ${data.clips?.length || 0} Shorts successfully!`);
    } catch (err) {
      console.error(err);
      setErrorMessage(err.message || "Failed to create Shorts from video.");
      setCurrentStep(0);
    } finally {
      clearTimeout(stepTimer1);
      clearTimeout(stepTimer2);
      setProcessing(false);
    }
  };

  // 1-Click Share to Instagram Reels
  const shareToInstagramReels = (clip) => {
    const targetClip = clip || clips[0];
    if (!targetClip) return;

    const hashtags = "#shorts #reels #viral #trending #fyp #contentcreator";
    const caption = customCaption
      ? `${customCaption} ${hashtags}`
      : `${targetClip.title || "Viral Short"} 🔥\n\n${targetClip.reason || ""}\n\n${hashtags}`;

    // 1. Copy caption to clipboard
    navigator.clipboard.writeText(caption);

    // 2. Trigger download of video
    const link = document.createElement("a");
    link.href = targetClip.videoUrl;
    link.download = targetClip.fileName || "short-reel.mp4";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // 3. Open Instagram Reels creator
    window.open("https://www.instagram.com/create/details/", "_blank");

    setSocialToast("📸 Video downloaded & Viral caption copied! Just upload the video in Instagram and press Ctrl+V to paste the caption.");
    setTimeout(() => setSocialToast(""), 8000);
  };

  // 1-Click Share to Facebook Reels
  const shareToFacebookReels = (clip) => {
    const targetClip = clip || clips[0];
    if (!targetClip) return;

    const hashtags = "#shorts #reels #viral #trending #fyp #contentcreator";
    const caption = customCaption
      ? `${customCaption} ${hashtags}`
      : `${targetClip.title || "Viral Short"} 🔥\n\n${targetClip.reason || ""}\n\n${hashtags}`;

    // 1. Copy caption to clipboard
    navigator.clipboard.writeText(caption);

    // 2. Trigger download of video
    const link = document.createElement("a");
    link.href = targetClip.videoUrl;
    link.download = targetClip.fileName || "short-reel.mp4";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // 3. Open Facebook Reels creator
    window.open("https://www.facebook.com/reels/create", "_blank");

    setSocialToast("👥 Video downloaded & Viral caption copied! Just drop the video in Facebook Reels and press Ctrl+V to paste the caption.");
    setTimeout(() => setSocialToast(""), 8000);
  };

  // Generate Script with Gemini
  const handleGenerateScript = async () => {
    if (!topic.trim()) {
      setErrorMessage("Please enter a topic for the script.");
      return;
    }

    setLoadingScript(true);
    setScript("");
    setErrorMessage("");
    setScriptCopied(false);

    try {
      const res = await fetch(`${API_BASE}/api/generate-script`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: topic.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || "Script generation failed.");
      }
      setScript(data.script);
    } catch (err) {
      setErrorMessage(err.message || "Failed to connect to backend.");
    } finally {
      setLoadingScript(false);
    }
  };

  const copyScriptToClipboard = () => {
    if (!script) return;
    navigator.clipboard.writeText(script);
    setScriptCopied(true);
    setTimeout(() => setScriptCopied(false), 2500);
  };

  return (
    <div className="app">
      {/* NAVBAR */}
      <header className="navbar">
        <div className="logo-container">
          <span className="logo-icon">🎬</span>
          <span className="logo-text">AI Short Maker</span>
        </div>

        <div className="nav-right">
          <div className={`status-badge ${serverOnline === true ? "online" : serverOnline === false ? "offline" : ""}`}>
            <span className="status-dot"></span>
            {serverOnline === true
              ? "Backend Connected"
              : serverOnline === false
              ? "Backend Offline (Port 5000)"
              : "Connecting..."}
          </div>
        </div>
      </header>

      {/* HERO SECTION */}
      <main className="main-content">
        <section className="hero">
          <div className="badge-pill">⚡ Powered by Gemini 3.6 Flash & FFmpeg</div>
          <h1>
            Turn Long YouTube & Raw Videos Into <span className="highlight-text">Viral Shorts</span>
          </h1>
          <p className="hero-subtitle">
            AI automatically finds the most engaging moments, cuts 30-second clips, and transforms them into professional 9:16 vertical Shorts.
          </p>

          {/* TABS SELECTOR */}
          <div className="tabs-container">
            <button
              className={`tab-btn ${activeTab === "youtube" ? "active" : ""}`}
              onClick={() => {
                setActiveTab("youtube");
                setErrorMessage("");
              }}
            >
              🎥 YouTube Link
            </button>
            <button
              className={`tab-btn ${activeTab === "upload" ? "active" : ""}`}
              onClick={() => {
                setActiveTab("upload");
                setErrorMessage("");
              }}
            >
              📁 Upload Video
            </button>
            <button
              className={`tab-btn ${activeTab === "script" ? "active" : ""}`}
              onClick={() => {
                setActiveTab("script");
                setErrorMessage("");
              }}
            >
              ✍️ AI Script Writer
            </button>
          </div>

          {/* TAB 1: YOUTUBE LINK */}
          {activeTab === "youtube" && (
            <div className="card-box">
              <form onSubmit={handleGenerateFromYoutube} className="input-group">
                <input
                  type="text"
                  placeholder="Paste YouTube Video URL (e.g. https://www.youtube.com/watch?v=...)"
                  value={youtubeUrl}
                  onChange={(e) => {
                    const val = e.target.value;
                    setYoutubeUrl(val);
                    if (val.length > 15 && (val.includes("youtube.com") || val.includes("youtu.be"))) {
                      handleFetchYoutubeInfo(val);
                    }
                  }}
                  disabled={processing}
                  className="main-input"
                />
                <button type="submit" className="action-btn" disabled={processing || !youtubeUrl.trim()}>
                  {processing ? "Creating Shorts..." : "✨ Generate Shorts"}
                </button>
              </form>

              {/* OPTIONS: Clip count & duration */}
              <div className="settings-row">
                <div className="setting-item">
                  <label>🎯 Number of Shorts:</label>
                  <select
                    value={clipCount}
                    onChange={(e) => setClipCount(Number(e.target.value))}
                    disabled={processing}
                    className="custom-select"
                  >
                    <option value={3}>3 Shorts (Fastest)</option>
                    <option value={5}>5 Shorts (Recommended)</option>
                    <option value={8}>8 Shorts</option>
                    <option value={10}>10 Shorts (Max Coverage)</option>
                  </select>
                </div>

                <div className="setting-item">
                  <label>⏱️ Target Duration:</label>
                  <select
                    value={targetDuration}
                    onChange={(e) => setTargetDuration(Number(e.target.value))}
                    disabled={processing}
                    className="custom-select"
                  >
                    <option value={30}>~30 Seconds (Fast Paced)</option>
                    <option value={45}>~45 Seconds (Balanced)</option>
                    <option value={60}>~60 Seconds (Detailed Story)</option>
                  </select>
                </div>
              </div>

              {/* YouTube Video Preview Card if loaded */}
              {videoInfo && (
                <div className="yt-preview-card">
                  {videoInfo.thumbnail && <img src={videoInfo.thumbnail} alt="Thumbnail" className="yt-thumb" />}
                  <div className="yt-info">
                    <h4>{videoInfo.title}</h4>
                    <p>Channel: {videoInfo.author || "YouTube Creator"}</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: UPLOAD VIDEO */}
          {activeTab === "upload" && (
            <div className="card-box">
              <div className="upload-dropzone">
                <input
                  type="file"
                  id="video-file-input"
                  accept="video/*"
                  onChange={(e) => setSelectedFile(e.target.files[0] || null)}
                  disabled={processing}
                />
                <label htmlFor="video-file-input" className="file-label">
                  <div className="upload-icon">📹</div>
                  <div className="upload-text">
                    {selectedFile ? (
                      <strong>Selected: {selectedFile.name} ({(selectedFile.size / (1024 * 1024)).toFixed(1)} MB)</strong>
                    ) : (
                      <>
                        <strong>Click or Drag video here to upload</strong>
                        <span>Supports MP4, MOV, MKV, WebM up to 1GB</span>
                      </>
                    )}
                  </div>
                </label>
              </div>

              {/* OPTIONS: Clip count & duration */}
              <div className="settings-row">
                <div className="setting-item">
                  <label>🎯 Number of Shorts:</label>
                  <select
                    value={clipCount}
                    onChange={(e) => setClipCount(Number(e.target.value))}
                    disabled={processing}
                    className="custom-select"
                  >
                    <option value={3}>3 Shorts</option>
                    <option value={5}>5 Shorts</option>
                    <option value={8}>8 Shorts</option>
                    <option value={10}>10 Shorts</option>
                  </select>
                </div>

                <div className="setting-item">
                  <label>⏱️ Target Duration:</label>
                  <select
                    value={targetDuration}
                    onChange={(e) => setTargetDuration(Number(e.target.value))}
                    disabled={processing}
                    className="custom-select"
                  >
                    <option value={30}>~30 Seconds</option>
                    <option value={45}>~45 Seconds</option>
                    <option value={60}>~60 Seconds</option>
                  </select>
                </div>
              </div>

              {selectedFile && (
                <button
                  onClick={handleGenerateFromUpload}
                  disabled={processing}
                  className="action-btn upload-submit-btn"
                >
                  {processing ? "Processing Video..." : "✨ Generate Shorts"}
                </button>
              )}
            </div>
          )}

          {/* TAB 3: SCRIPT WRITER */}
          {activeTab === "script" && (
            <div className="card-box script-card">
              <div className="input-group">
                <input
                  type="text"
                  placeholder="Enter video topic (e.g. 5 Crazy Facts About the Ocean)"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  disabled={loadingScript}
                  className="main-input"
                />
                <button
                  onClick={handleGenerateScript}
                  disabled={loadingScript || !topic.trim()}
                  className="action-btn"
                >
                  {loadingScript ? "Writing Script..." : "🚀 Write Script"}
                </button>
              </div>

              {script && (
                <div className="script-container">
                  <div className="script-header">
                    <h3>Viral Short Script</h3>
                    <button className="copy-btn" onClick={copyScriptToClipboard}>
                      {scriptCopied ? "✓ Copied!" : "📋 Copy"}
                    </button>
                  </div>
                  <pre className="script-content">{script}</pre>
                </div>
              )}
            </div>
          )}

          {/* PROGRESS STEP INDICATOR */}
          {processing && (
            <div className="processing-status-card">
              <div className="spinner"></div>
              <div className="progress-steps">
                <div className={`step-item ${currentStep >= 1 ? "active" : ""}`}>
                  <span className="step-num">1</span>
                  <span>Fetch Video</span>
                </div>
                <div className="step-connector"></div>
                <div className={`step-item ${currentStep >= 2 ? "active" : ""}`}>
                  <span className="step-num">2</span>
                  <span>AI Hook Detection</span>
                </div>
                <div className="step-connector"></div>
                <div className={`step-item ${currentStep >= 3 ? "active" : ""}`}>
                  <span className="step-num">3</span>
                  <span>9:16 FFmpeg Render</span>
                </div>
              </div>
              <p className="status-message">{statusMessage}</p>
            </div>
          )}

          {/* ERROR ALERT */}
          {errorMessage && (
            <div className="error-alert">
              ⚠️ {errorMessage}
            </div>
          )}

          {/* SOCIAL SUCCESS NOTIFICATION TOAST */}
          {socialToast && (
            <div className="social-toast-alert">
              {socialToast}
            </div>
          )}
        </section>

        {/* RESULTS SECTION: GENERATED SHORTS */}
        {clips.length > 0 && (
          <section className="results-section">
            <div className="results-header">
              <h2>🎬 Generated AI Shorts ({clips.length})</h2>
              <p>Ready to preview, download, and publish to Instagram Reels & Facebook Reels</p>
            </div>

            <div className="shorts-grid">
              {clips.map((clip, index) => (
                <div className="short-card" key={clip.id || index}>
                  <div className="video-player-container">
                    <video
                      src={clip.videoUrl}
                      controls
                      playsInline
                      preload="metadata"
                      className="short-video"
                    />
                  </div>

                  <div className="short-details">
                    <div className="short-tag">SHORT #{index + 1}</div>
                    <h3 className="short-title">{clip.title}</h3>
                    {clip.reason && <p className="short-reason">{clip.reason}</p>}

                    <div className="short-meta">
                      <span className="meta-badge">
                        ⏱️ {clip.start.toFixed(0)}s → {clip.end.toFixed(0)}s ({clip.duration}s)
                      </span>
                      <span className="meta-badge format">9:16 Vertical</span>
                    </div>

                    {/* ACTION BUTTONS ON EACH CARD */}
                    <div className="card-actions-grid">
                      <a
                        href={clip.videoUrl}
                        download={clip.fileName || `short-${index + 1}.mp4`}
                        className="download-btn-primary"
                      >
                        ⬇ Download MP4 Short
                      </a>
                      
                      <div className="quick-share-buttons">
                        <button
                          className="quick-share-btn ig-quick-btn"
                          onClick={() => shareToInstagramReels(clip)}
                        >
                          📸 Share to Insta Reel
                        </button>
                        <button
                          className="quick-share-btn fb-quick-btn"
                          onClick={() => shareToFacebookReels(clip)}
                        >
                          👥 Share to FB Reel
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* ==============================================================
                1-CLICK SOCIAL MEDIA PUBLISHER (INSTAGRAM & FACEBOOK REELS)
            ============================================================== */}
            <div className="social-publish-container">
              <div className="social-header">
                <div className="social-badge">📲 1-Click Social Media Publisher</div>
                <h3>Kya aap ye Shorts direct Facebook & Instagram profile par share karna chahte hain?</h3>
                <p>Neeche 1-Click button par tap karein — video turant download ho jayegi, viral caption copy ho jayega, aur Instagram/Facebook Reels upload screen khul jayegi!</p>
              </div>

              {/* SOCIAL ACTION CARDS */}
              <div className="social-grid">
                {/* 1. INSTAGRAM REELS CARD */}
                <div className="social-card instagram">
                  <div className="social-card-top">
                    <div className="platform-icon ig-icon">📸</div>
                    <div>
                      <h4>Instagram Reels</h4>
                      <p className="platform-desc">Auto-downloads MP4 + auto-copies viral caption & hashtags</p>
                    </div>
                  </div>

                  <button
                    className="social-connect-btn ig-btn"
                    onClick={() => shareToInstagramReels(clips[0])}
                  >
                    🚀 1-Click Share to Instagram Reels
                  </button>
                </div>

                {/* 2. FACEBOOK REELS CARD */}
                <div className="social-card facebook">
                  <div className="social-card-top">
                    <div className="platform-icon fb-icon">👥</div>
                    <div>
                      <h4>Facebook Reels</h4>
                      <p className="platform-desc">Auto-downloads MP4 + opens Facebook Reels Creator</p>
                    </div>
                  </div>

                  <button
                    className="social-connect-btn fb-btn"
                    onClick={() => shareToFacebookReels(clips[0])}
                  >
                    🚀 1-Click Share to Facebook Reels
                  </button>
                </div>
              </div>

              {/* CUSTOM CAPTION EDITOR */}
              <div className="publish-actions-box">
                <div className="caption-input-box">
                  <label>✍️ Custom Caption (Optional):</label>
                  <input
                    type="text"
                    placeholder="Custom caption (leave empty to use AI viral title & hashtags)"
                    value={customCaption}
                    onChange={(e) => setCustomCaption(e.target.value)}
                    className="main-input caption-input"
                  />
                </div>
              </div>
            </div>
          </section>
        )}
      </main>

      {/* FOOTER */}
      <footer className="footer">
        <p>AI Short Maker • Built with React, Node.js, Google Gemini & FFmpeg</p>
      </footer>
    </div>
  );
}

export default App;
