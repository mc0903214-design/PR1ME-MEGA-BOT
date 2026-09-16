const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { Telegraf, Markup } = require('telegraf');
const { File: MegaFile, Folder: MegaFolder } = require('megajs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const sharp = require('sharp');

// Configure FFmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

// ==========================================
// CONFIGURATION & ENVIRONMENT
// ==========================================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('FATAL ERROR: BOT_TOKEN environment variable is missing.');
  process.exit(1);
}

const TEMP_DIR = process.env.TEMP_DIR || path.join(__dirname, 'temp');
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10);
const MAX_TELEGRAM_UPLOAD_MB = parseInt(process.env.MAX_TELEGRAM_UPLOAD_MB || '2000', 10);
const ITEMS_PER_PAGE = 8;
const PROGRESS_THROTTLE_MS = 2500; // Prevent Telegram rate limiting

// Ensure temp directory exists
fs.ensureDirSync(TEMP_DIR);

// ==========================================
// GLOBAL STATE MANAGEMENT
// ==========================================
const bot = new Telegraf(BOT_TOKEN);
const userSessions = new Map(); // chatId -> Session State
const globalQueue = [];
let activeJobsCount = 0;

// Helper: Generate safe ID
const generateId = () => crypto.randomBytes(6).toString('hex');

// Format bytes into readable format
function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Format seconds to ETA format
function formatETA(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return 'Calculating...';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Render visual progress bar
function renderProgressBar(percent) {
  const totalBlocks = 10;
  const filledBlocks = Math.round((percent / 100) * totalBlocks);
  const emptyBlocks = totalBlocks - filledBlocks;
  return '█'.repeat(Math.min(totalBlocks, Math.max(0, filledBlocks))) + '░'.repeat(Math.min(totalBlocks, Math.max(0, emptyBlocks)));
}

// Get file emoji
function getFileEmoji(name = '') {
  const ext = path.extname(name).toLowerCase();
  if (['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv'].includes(ext)) return '🎬';
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext)) return '🖼';
  if (['.mp3', '.m4a', '.flac', '.wav', '.aac', '.ogg'].includes(ext)) return '🎵';
  if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2'].includes(ext)) return '📦';
  if (['.pdf', '.txt', '.doc', '.docx', '.epub'].includes(ext)) return '📄';
  return '📄';
}

// Clean temporary file safely
async function cleanupFile(filePath) {
  if (!filePath) return;
  try {
    if (await fs.pathExists(filePath)) {
      await fs.remove(filePath);
      console.log(`[CLEANUP] Deleted temp file: ${filePath}`);
    }
  } catch (err) {
    console.error(`[CLEANUP ERROR] Failed to delete ${filePath}:`, err.message);
  }
}

// ==========================================
// SESSION MANAGERS
// ==========================================
function getOrCreateSession(chatId) {
  if (!userSessions.has(chatId)) {
    userSessions.set(chatId, {
      sid: generateId(),
      chatId,
      megaNode: null,       // Root Mega Node
      currentPath: [],       // Array of index pointers or sub-nodes
      selectedFiles: new Set(), // Set of Node IDs selected
      currentPage: 0,
      activeJob: null,       // Active download job
      lastMessageId: null
    });
  }
  return userSessions.get(chatId);
}

async function resetSession(chatId) {
  const session = userSessions.get(chatId);
  if (session) {
    if (session.activeJob) {
      session.activeJob.cancelled = true;
      if (session.activeJob.ffmpegProc) {
        try { session.activeJob.ffmpegProc.kill('SIGKILL'); } catch (e) {}
      }
    }
    userSessions.delete(chatId);
  }
  return getOrCreateSession(chatId);
}

// Get current directory contents based on session navigation
function getCurrentDirectoryNode(session) {
  let current = session.megaNode;
  if (!current) return null;

  for (const stepId of session.currentPath) {
    if (current.children) {
      const found = current.children.find(child => child.id === stepId || child.name === stepId);
      if (found) {
        current = found;
      }
    }
  }
  return current;
}

// Recursive file collection
function collectFilesRecursively(node, fileList = []) {
  if (!node) return fileList;
  if (!node.directory) {
    fileList.push(node);
  } else if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      collectFilesRecursively(child, fileList);
    }
  }
  return fileList;
}

// Map tree for UI representation
function mapMegaTree(node) {
  if (!node) return null;
  const item = {
    id: node.id || generateId(),
    name: node.name || 'Root',
    size: node.size || 0,
    directory: !!node.directory,
    rawNode: node,
    children: []
  };

  if (node.directory && node.children) {
    item.children = node.children.map(child => mapMegaTree(child));
  }
  return item;
}

// ==========================================
// TELEGRAM UI RENDERERS
// ==========================================
function buildBrowserUI(session) {
  const currentNode = getCurrentDirectoryNode(session);
  if (!currentNode) return { text: 'No content available.', keyboard: Markup.inlineKeyboard([]) };

  let titlePath = '/' + session.currentPath.join('/');
  let text = `📁 *MEGA File Browser*\n📍 *Path:* \`${titlePath}\`\n\n`;

  const items = currentNode.children || [];
  const totalPages = Math.ceil(items.length / ITEMS_PER_PAGE) || 1;
  session.currentPage = Math.max(0, Math.min(session.currentPage, totalPages - 1));

  const startIdx = session.currentPage * ITEMS_PER_PAGE;
  const pageItems = items.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  const keyboard = [];

  if (pageItems.length === 0) {
    text += `_This folder is empty._\n`;
  } else {
    pageItems.forEach(item => {
      const isSelected = session.selectedFiles.has(item.id);
      const icon = item.directory ? '📂' : getFileEmoji(item.name);
      const selectMark = isSelected ? '☑️ ' : item.directory ? '' : '☐ ';
      const label = `${selectMark}${icon} ${item.name}` + (item.directory ? '' : ` (${formatBytes(item.size)})`);

      // Callback payload format: action:nodeId
      keyboard.push([Markup.button.callback(label.substring(0, 40), `nav:${item.id}`)]);
    });
  }

  text += `\n📄 *Page:* ${session.currentPage + 1}/${totalPages} | *Selected:* ${session.selectedFiles.size} items`;

  // Action Bar 1: Pagination
  const pageRow = [];
  if (session.currentPage > 0) {
    pageRow.push(Markup.button.callback('⬅️ Prev', 'page:prev'));
  }
  if (session.currentPage < totalPages - 1) {
    pageRow.push(Markup.button.callback('Next ➡️', 'page:next'));
  }
  if (pageRow.length) keyboard.push(pageRow);

  // Action Bar 2: Download Options
  const dlRow = [];
  if (currentNode.directory) {
    dlRow.push(Markup.button.callback('📥 Download Folder', 'dl:curr'));
  }
  if (session.selectedFiles.size > 0) {
    dlRow.push(Markup.button.callback(`✅ Download Selected (${session.selectedFiles.size})`, 'dl:sel'));
  }
  if (dlRow.length) keyboard.push(dlRow);

  // Action Bar 3: Selection Controls
  const selRow = [];
  if (currentNode.directory && items.some(i => !i.directory)) {
    selRow.push(Markup.button.callback('☑️ Select All Here', 'sel:all'));
  }
  if (session.selectedFiles.size > 0) {
    selRow.push(Markup.button.callback('🔄 Clear', 'sel:clear'));
  }
  if (selRow.length) keyboard.push(selRow);

  // Action Bar 4: Navigation
  const navRow = [];
  if (session.currentPath.length > 0) {
    navRow.push(Markup.button.callback('⬅️ Back', 'nav:back'));
    navRow.push(Markup.button.callback('🏠 Root', 'nav:root'));
  }
  navRow.push(Markup.button.callback('❌ Cancel', 'act:cancel'));
  keyboard.push(navRow);

  return { text, keyboard: Markup.inlineKeyboard(keyboard) };
}

// Update Telegram view safely
async function renderOrUpdateBrowser(ctx, session) {
  const ui = buildBrowserUI(session);
  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(ui.text, { parse_mode: 'Markdown', ...ui.keyboard });
    } else {
      const msg = await ctx.reply(ui.text, { parse_mode: 'Markdown', ...ui.keyboard });
      session.lastMessageId = msg.message_id;
    }
  } catch (err) {
    if (!err.message.includes('message is not modified')) {
      console.error('[UI RENDER ERROR]', err.message);
    }
  }
}

// ==========================================
// MEDIA OPTIMIZATION ENGINE
// ==========================================
async function optimizeMedia(filePath, job) {
  const ext = path.extname(filePath).toLowerCase();
  const originalSize = (await fs.stat(filePath)).size;
  const fileDir = path.dirname(filePath);
  const fileName = path.basename(filePath, ext);
  const outputPath = path.join(fileDir, `opt_${fileName}${ext}`);

  // 1. VIDEO OPTIMIZATION (FFmpeg)
  if (['.mp4', '.mkv', '.avi', '.mov', '.webm'].includes(ext)) {
    return new Promise((resolve) => {
      job.status = 'Optimizing Video (FFmpeg)...';
      job.updateProgress(0, originalSize, 'FFmpeg');

      let proc = ffmpeg(filePath)
        .outputOptions([
          '-c:v libx264',
          '-crf 28',            // Quality threshold (good compression/quality ratio)
          '-preset faster',
          '-c:a aac',
          '-b:a 128k',
          '-movflags +faststart'
        ])
        .output(outputPath)
        .on('start', (cmdline) => {
          console.log('[FFMPEG STARTED]', cmdline);
        })
        .on('progress', (progress) => {
          if (job.cancelled) {
            try { proc.kill('SIGKILL'); } catch (e) {}
            return;
          }
          if (progress.percent) {
            job.updateProgress(Math.round(progress.percent), 100, 'FFmpeg Encoding');
          }
        })
        .on('end', async () => {
          job.ffmpegProc = null;
          if (await fs.pathExists(outputPath)) {
            const optSize = (await fs.stat(outputPath)).size;
            // Only use if saved > 5% space
            if (optSize < originalSize * 0.95) {
              await cleanupFile(filePath);
              return resolve({ path: outputPath, originalSize, finalSize: optSize, optimized: true });
            } else {
              await cleanupFile(outputPath); // Discard unhelpful optimization
            }
          }
          resolve({ path: filePath, originalSize, finalSize: originalSize, optimized: false });
        })
        .on('error', async (err) => {
          console.error('[FFMPEG ERROR]', err.message);
          job.ffmpegProc = null;
          await cleanupFile(outputPath);
          resolve({ path: filePath, originalSize, finalSize: originalSize, optimized: false });
        });

      job.ffmpegProc = proc;
      proc.run();
    });
  }

  // 2. IMAGE OPTIMIZATION (Sharp)
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
    try {
      job.status = 'Optimizing Image...';
      const img = sharp(filePath);
      const metadata = await img.metadata();

      let pipeline = img;
      if (metadata.width && metadata.width > 2048) {
        pipeline = pipeline.resize({ width: 2048, fit: 'inside', withoutEnlargement: true });
      }

      if (ext === '.jpg' || ext === '.jpeg') {
        pipeline = pipeline.jpeg({ quality: 80, progressive: true });
      } else if (ext === '.png') {
        pipeline = pipeline.png({ quality: 80, compressionLevel: 8 });
      } else if (ext === '.webp') {
        pipeline = pipeline.webp({ quality: 80 });
      }

      await pipeline.toFile(outputPath);

      const optSize = (await fs.stat(outputPath)).size;
      if (optSize < originalSize * 0.95) {
        await cleanupFile(filePath);
        return { path: outputPath, originalSize, finalSize: optSize, optimized: true };
      } else {
        await cleanupFile(outputPath);
      }
    } catch (err) {
      console.error('[IMAGE OPTIMIZATION ERROR]', err.message);
      await cleanupFile(outputPath);
    }
  }

  // Default: Return original as-is
  return { path: filePath, originalSize, finalSize: originalSize, optimized: false };
}

// ==========================================
// CORE DOWNLOAD & UPLOAD PIPELINE
// ==========================================
async function executeJob(job) {
  const { ctx, files, session } = job;
  activeJobsCount++;

  let processedCount = 0;
  let failedCount = 0;
  let totalOriginalBytes = 0;
  let totalFinalBytes = 0;
  const failedFiles = [];

  try {
    for (let i = 0; i < files.length; i++) {
      if (job.cancelled) break;

      const fileItem = files[i];
      const rawNode = fileItem.rawNode;
      const fileName = fileItem.name;
      const tempFilePath = path.join(TEMP_DIR, `${Date.now()}_${generateId()}_${fileName}`);

      job.currentFileName = fileName;
      job.currentIndex = i + 1;
      job.totalFiles = files.length;

      console.log(`[JOB START] Processing (${i + 1}/${files.length}): ${fileName}`);

      // ------------------------------------
      // STEP 1: MEGA DOWNLOAD STREAM
      // ------------------------------------
      let downloadSuccess = false;
      try {
        job.status = `⬇️ Downloading (${i + 1}/${files.length})`;
        
        await new Promise((resolve, reject) => {
          const dlStream = rawNode.download();
          const writeStream = fs.createWriteStream(tempFilePath);

          let downloadedBytes = 0;
          const totalBytes = fileItem.size || 0;
          let lastTime = Date.now();
          let lastBytes = 0;

          dlStream.on('data', (chunk) => {
            if (job.cancelled) {
              dlStream.destroy();
              writeStream.destroy();
              return reject(new Error('Job cancelled by user'));
            }

            downloadedBytes += chunk.length;
            const now = Date.now();
            const timeDiff = (now - lastTime) / 1000;

            if (timeDiff >= 1 || downloadedBytes === totalBytes) {
              const bytesDiff = downloadedBytes - lastBytes;
              const speed = timeDiff > 0 ? bytesDiff / timeDiff : 0;
              const remainingBytes = totalBytes - downloadedBytes;
              const eta = speed > 0 ? remainingBytes / speed : 0;

              const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
              const extraInfo = `Speed: ${formatBytes(speed)}/s\nETA: ${formatETA(eta)}`;

              job.updateProgress(percent, totalBytes, extraInfo, downloadedBytes);

              lastTime = now;
              lastBytes = downloadedBytes;
            }
          });

          dlStream.pipe(writeStream);

          writeStream.on('finish', () => {
            downloadSuccess = true;
            resolve();
          });

          dlStream.on('error', (err) => reject(err));
          writeStream.on('error', (err) => reject(err));
        });
      } catch (err) {
        console.error(`[DOWNLOAD FAILED] ${fileName}:`, err.message);
        failedCount++;
        failedFiles.push({ name: fileName, reason: err.message });
        await cleanupFile(tempFilePath);
        continue;
      }

      if (job.cancelled) {
        await cleanupFile(tempFilePath);
        break;
      }

      // ------------------------------------
      // STEP 2: MEDIA OPTIMIZATION
      // ------------------------------------
      let finalFilePath = tempFilePath;
      let originalSize = fileItem.size || 0;
      let finalSize = originalSize;

      try {
        const optResult = await optimizeMedia(tempFilePath, job);
        finalFilePath = optResult.path;
        originalSize = optResult.originalSize;
        finalSize = optResult.finalSize;
      } catch (err) {
        console.error(`[OPTIMIZE ERROR] ${fileName}:`, err.message);
      }

      totalOriginalBytes += originalSize;
      totalFinalBytes += finalSize;

      // ------------------------------------
      // STEP 3: TELEGRAM SIZE CHECK & UPLOAD
      // ------------------------------------
      const limitBytes = MAX_TELEGRAM_UPLOAD_MB * 1024 * 1024;
      if (finalSize > limitBytes) {
        failedCount++;
        failedFiles.push({ name: fileName, reason: `Exceeds Telegram limit (${formatBytes(finalSize)} > ${MAX_TELEGRAM_UPLOAD_MB}MB)` });
        await cleanupFile(finalFilePath);
        continue;
      }

      try {
        job.status = `📤 Uploading to Telegram (${i + 1}/${files.length})`;
        job.updateProgress(100, finalSize, 'Sending to chat...');

        const ext = path.extname(fileName).toLowerCase();
        const readStream = fs.createReadStream(finalFilePath);

        if (['.mp4', '.mkv', '.avi', '.mov'].includes(ext)) {
          await ctx.replyWithVideo({ source: readStream, filename: fileName }, { caption: `🎬 *${fileName}*\nSize: ${formatBytes(finalSize)}`, parse_mode: 'Markdown' });
        } else if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
          await ctx.replyWithPhoto({ source: readStream }, { caption: `🖼 *${fileName}*` });
        } else if (['.mp3', '.m4a', '.flac', '.wav'].includes(ext)) {
          await ctx.replyWithAudio({ source: readStream, filename: fileName }, { caption: `🎵 *${fileName}*` });
        } else {
          await ctx.replyWithDocument({ source: readStream, filename: fileName }, { caption: `📄 *${fileName}*\nSize: ${formatBytes(finalSize)}`, parse_mode: 'Markdown' });
        }

        processedCount++;
      } catch (err) {
        console.error(`[TELEGRAM UPLOAD FAILED] ${fileName}:`, err.message);
        failedCount++;
        failedFiles.push({ name: fileName, reason: `Upload error: ${err.message}` });
      } finally {
        await cleanupFile(finalFilePath);
      }
    }

    // ------------------------------------
    // STEP 4: FINAL SUMMARY RENDER
    // ------------------------------------
    if (!job.cancelled) {
      let summary = `🎉 *Download Process Completed*\n\n`;
      summary += `📦 *Total Processed:* ${processedCount + failedCount}\n`;
      summary += `✅ *Successfully Sent:* ${processedCount}\n`;
      summary += `❌ *Failed:* ${failedCount}\n\n`;

      if (processedCount > 0) {
        summary += `📊 *Original Total Size:* ${formatBytes(totalOriginalBytes)}\n`;
        summary += `📉 *Final Sent Size:* ${formatBytes(totalFinalBytes)}\n`;
        const saved = totalOriginalBytes - totalFinalBytes;
        if (saved > 0) {
          summary += `💡 *Space Saved:* ${formatBytes(saved)}\n`;
        }
      }

      if (failedFiles.length > 0) {
        summary += `\n⚠️ *Failed Files Details:*\n`;
        failedFiles.forEach(f => {
          summary += `• *${f.name}*: ${f.reason}\n`;
        });
      }

      await ctx.reply(summary, { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('❌ *Job was cancelled by user. Temporary files cleaned up.*', { parse_mode: 'Markdown' });
    }

  } catch (err) {
    console.error('[CRITICAL JOB ERROR]', err);
    await ctx.reply(`❌ *An unexpected error occurred during processing:* ${err.message}`, { parse_mode: 'Markdown' });
  } finally {
    activeJobsCount--;
    session.activeJob = null;
    processNextQueue();
  }
}

// Queue Processor
function processNextQueue() {
  if (globalQueue.length === 0 || activeJobsCount >= MAX_CONCURRENT_JOBS) {
    return;
  }
  const nextJob = globalQueue.shift();
  executeJob(nextJob);
}

// Progress Throttler
function createThrottledProgressUpdater(ctx, job) {
  let lastUpdate = 0;

  return async (percent, total, extraInfo = '', currentBytes = 0) => {
    const now = Date.now();
    if (now - lastUpdate < PROGRESS_THROTTLE_MS && percent < 100) {
      return;
    }
    lastUpdate = now;

    const bar = renderProgressBar(percent);
    let msg = `${job.status}\n\n`;
    msg += `📄 *File:* \`${job.currentFileName}\` (${job.currentIndex}/${job.totalFiles})\n`;
    if (total > 0 && currentBytes > 0) {
      msg += `📊 *Progress:* ${formatBytes(currentBytes)} / ${formatBytes(total)}\n`;
    }
    msg += `[${bar}] *${percent}%*\n`;
    if (extraInfo) {
      msg += `\n${extraInfo}`;
    }

    try {
      if (job.progressMsgId) {
        await ctx.telegram.editMessageText(ctx.chat.id, job.progressMsgId, null, msg, { parse_mode: 'Markdown' });
      } else {
        const sent = await ctx.reply(msg, { parse_mode: 'Markdown' });
        job.progressMsgId = sent.message_id;
      }
    } catch (err) {
      if (!err.message.includes('message is not modified')) {
        console.error('[PROGRESS UPDATE ERROR]', err.message);
      }
    }
  };
}

// ==========================================
// TELEGRAM BOT COMMANDS & HANDLERS
// ==========================================

// /start Command
bot.start(async (ctx) => {
  const session = await resetSession(ctx.chat.id);
  const welcomeText = `📥 *MEGA Downloader Bot*\n\n` +
    `Send me any MEGA.nz file or folder link and I'll let you browse the contents and download them directly here in Telegram.\n\n` +
    `*Features:*\n` +
    `• Browse deep folder hierarchies\n` +
    `• Select individual or multiple files\n` +
    `• Download full folders with recursive search\n` +
    `• Smart media optimization (FFmpeg & Sharp)\n` +
    `• Queue management & active progress bars\n\n` +
    `*Send a MEGA link to begin!*`;

  await ctx.reply(welcomeText, { parse_mode: 'Markdown' });
});

// /help Command
bot.help(async (ctx) => {
  const helpText = `❓ *Help & Usage Guide*\n\n` +
    `1. *Paste a MEGA Link:* Send any public MEGA.nz file or folder URL.\n` +
    `2. *Navigate Folders:* Use inline keyboard buttons to explore folders.\n` +
    `3. *Selection:* Click on files with ` + '`☐`' + ` to select them for batch download.\n` +
    `4. *Download Options:*\n` +
    `   • *Download Folder:* Recursively fetches all files inside.\n` +
    `   • *Download Selected:* Downloads items you explicitly checked.\n` +
    `5. *Optimization:* Videos & Images are smartly compressed to stay within Telegram upload limits while maintaining high visual quality.\n` +
    `6. *Cancel:* Type /cancel at any time to halt downloads and purge temp files.`;

  await ctx.reply(helpText, { parse_mode: 'Markdown' });
});

// /cancel Command
bot.command('cancel', async (ctx) => {
  const session = getOrCreateSession(ctx.chat.id);
  if (session.activeJob) {
    session.activeJob.cancelled = true;
    if (session.activeJob.ffmpegProc) {
      try { session.activeJob.ffmpegProc.kill('SIGKILL'); } catch (e) {}
    }
    await ctx.reply('🛑 *Cancel signal sent. Cleaning up current operations...*', { parse_mode: 'Markdown' });
  } else {
    await ctx.reply('ℹ️ *No active download job running.*', { parse_mode: 'Markdown' });
  }
});

// Process Incoming Messages (MEGA Link Parsing)
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();

  // Validate MEGA link regex
  if (!text.includes('mega.nz')) {
    return ctx.reply('⚠️ Please send a valid MEGA.nz link (e.g., `https://mega.nz/folder/...` or `https://mega.nz/file/...`)', { parse_mode: 'Markdown' });
  }

  const session = await resetSession(ctx.chat.id);
  const loadingMsg = await ctx.reply('🔍 *Inspecting MEGA link and loading structure...*', { parse_mode: 'Markdown' });

  try {
    const node = File.fromURL(text);
    await new Promise((resolve, reject) => {
      node.loadAttributes((err, loadedNode) => {
        if (err) return reject(err);
        resolve(loadedNode);
      });
    });

    session.megaNode = mapMegaTree(node);
    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
    await renderOrUpdateBrowser(ctx, session);

  } catch (err) {
    console.error('[LINK PARSE ERROR]', err.message);
    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
    await ctx.reply(`❌ *Failed to access MEGA link:* ${err.message}\nEnsure the link is public and valid.`, { parse_mode: 'Markdown' });
  }
});

// ==========================================
// CALLBACK QUERY INTERACTION ROUTER
// ==========================================
bot.on('callback_query', async (ctx) => {
  const session = getOrCreateSession(ctx.chat.id);
  const data = ctx.callbackQuery.data;

  try {
    await ctx.answerCbQuery();

    if (!session.megaNode) {
      return ctx.reply('⚠️ *Session expired or lost.* Please send the MEGA link again.', { parse_mode: 'Markdown' });
    }

    const currentDir = getCurrentDirectoryNode(session);

    // 1. NAVIGATION
    if (data.startsWith('nav:')) {
      const targetId = data.replace('nav:', '');

      if (targetId === 'root') {
        session.currentPath = [];
      } else if (targetId === 'back') {
        session.currentPath.pop();
      } else {
        const foundChild = currentDir.children.find(c => c.id === targetId);
        if (foundChild) {
          if (foundChild.directory) {
            session.currentPath.push(foundChild.id);
            session.currentPage = 0;
          } else {
            // Toggle selection if file clicked directly
            if (session.selectedFiles.has(foundChild.id)) {
              session.selectedFiles.delete(foundChild.id);
            } else {
              session.selectedFiles.add(foundChild.id);
            }
          }
        }
      }
      return renderOrUpdateBrowser(ctx, session);
    }

    // 2. PAGINATION
    if (data.startsWith('page:')) {
      const dir = data.replace('page:', '');
      session.currentPage += (dir === 'next' ? 1 : -1);
      return renderOrUpdateBrowser(ctx, session);
    }

    // 3. SELECTION CONTROLS
    if (data.startsWith('sel:')) {
      const act = data.replace('sel:', '');
      if (act === 'all') {
        currentDir.children.forEach(c => {
          if (!c.directory) session.selectedFiles.add(c.id);
        });
      } else if (act === 'clear') {
        session.selectedFiles.clear();
      }
      return renderOrUpdateBrowser(ctx, session);
    }

    // 4. CANCEL SESSION
    if (data === 'act:cancel') {
      await resetSession(ctx.chat.id);
      return ctx.editMessageText('❌ *Session closed and cleared.*', { parse_mode: 'Markdown' });
    }

    // 5. DOWNLOAD INITIATION
    if (data.startsWith('dl:')) {
      const mode = data.replace('dl:', '');
      let filesToDownload = [];

      if (mode === 'curr') {
        filesToDownload = collectFilesRecursively(currentDir);
      } else if (mode === 'sel') {
        const allFiles = collectFilesRecursively(session.megaNode);
        filesToDownload = allFiles.filter(f => session.selectedFiles.has(f.id));
      }

      if (filesToDownload.length === 0) {
        return ctx.reply('⚠️ No files found for download.', { parse_mode: 'Markdown' });
      }

      if (session.activeJob) {
        return ctx.reply('⚠️ You already have an active job running. Wait for it or send /cancel.', { parse_mode: 'Markdown' });
      }

      // Create new job
      const job = {
        id: generateId(),
        ctx,
        session,
        files: filesToDownload,
        cancelled: false,
        status: 'Queued...',
        currentFileName: '',
        currentIndex: 0,
        totalFiles: filesToDownload.length,
        progressMsgId: null,
        ffmpegProc: null
      };

      job.updateProgress = createThrottledProgressUpdater(ctx, job);
      session.activeJob = job;

      globalQueue.push(job);
      await ctx.reply(`📋 *Job added to queue.* Position in queue: ${globalQueue.length}\nFiles: ${filesToDownload.length}`, { parse_mode: 'Markdown' });

      processNextQueue();
    }

  } catch (err) {
    console.error('[CALLBACK ERROR]', err);
  }
});

// ==========================================
// PROCESS SHUTDOWN & LIFECYCLE
// ==========================================
async function gracefulShutdown(signal) {
  console.log(`[SHUTDOWN] Received ${signal}. Cleaning up...`);
  for (const [chatId, session] of userSessions.entries()) {
    if (session.activeJob) {
      session.activeJob.cancelled = true;
      if (session.activeJob.ffmpegProc) {
        try { session.activeJob.ffmpegProc.kill('SIGKILL'); } catch (e) {}
      }
    }
  }
  // Clear temp directory
  await fs.emptyDir(TEMP_DIR);
  console.log('[SHUTDOWN] Cleanup complete. Exiting.');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Launch Bot
bot.launch().then(() => {
  console.log('🚀 MEGA Telegram Bot successfully started and listening!');
}).catch((err) => {
  console.error('FATAL: Bot launch failed:', err.message);
  process.exit(1);
});
