const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const { Telegraf, Markup } = require('telegraf');
const { File: MegaFile } = require('megajs');
const mime = require('mime-types');

// --- CONFIGURATION & ENV ---
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('[CRITICAL] BOT_TOKEN environment variable is missing.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const TEMP_DIR = path.join(os.tmpdir(), 'mega-downloader-bot');
fs.ensureDirSync(TEMP_DIR);

const ITEMS_PER_PAGE = 8;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes cleanup

// --- IN-MEMORY SESSION STORE ---
// Map<userId, UserSession>
const userSessions = new Map();

class UserSession {
  constructor(userId) {
    this.userId = userId;
    this.rootNode = null;          // Mega File/Folder object
    this.currentFolder = null;    // Currently active folder node
    this.pathStack = [];          // [{ id, name, node }] navigation history
    this.selectedIds = new Set(); // Selected node IDs
    this.page = 0;                // Current pagination page
    this.activeJob = null;        // { cancelled: false, stream: null, tempFilePath: null, messageId: null }
    this.lastActivity = Date.now();
    this.lastMsgEditTime = 0;     // Per-user message edit throttle
  }

  touch() {
    this.lastActivity = Date.now();
  }

  cancelActiveJob() {
    if (this.activeJob) {
      this.activeJob.cancelled = true;
      if (this.activeJob.stream && typeof this.activeJob.stream.destroy === 'function') {
        try { this.activeJob.stream.destroy(); } catch (_) {}
      }
      if (this.activeJob.tempFilePath && fs.existsSync(this.activeJob.tempFilePath)) {
        try { fs.removeSync(this.activeJob.tempFilePath); } catch (_) {}
      }
      this.activeJob = null;
    }
  }

  reset() {
    this.cancelActiveJob();
    this.rootNode = null;
    this.currentFolder = null;
    this.pathStack = [];
    this.selectedIds.clear();
    this.page = 0;
  }
}

function getSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, new UserSession(userId));
  }
  const session = userSessions.get(userId);
  session.touch();
  return session;
}

// Garbage collection for stale sessions
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of userSessions.entries()) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS && !session.activeJob) {
      userSessions.delete(userId);
    }
  }
}, 5 * 60 * 1000);

// --- HELPER FUNCTIONS ---

/**
 * Parses common MEGA public URLs including direct subfolder and file links.
 * Handles forms like:
 * - https://mega.nz/file/ID#KEY
 * - https://mega.nz/folder/ID#KEY
 * - https://mega.nz/folder/ROOT_ID#ROOT_KEY/folder/SUBFOLDER_ID
 * - https://mega.nz/folder/ROOT_ID#ROOT_KEY/file/FILE_ID
 */
function parseMegaUrl(rawUrl) {
  try {
    const urlStr = rawUrl.trim();
    if (!urlStr.includes('mega.nz')) return null;

    // Check direct file link: mega.nz/file/ID#KEY or legacy mega.nz/#!ID!KEY
    const fileMatch = urlStr.match(/mega\.nz\/(?:#!)?file\/([a-zA-Z0-9_-]+)#([a-zA-Z0-9_-]+)/);
    if (fileMatch) {
      return { type: 'file', id: fileMatch[1], key: fileMatch[2], rawUrl: urlStr };
    }

    const legacyFileMatch = urlStr.match(/mega\.nz\/#!([a-zA-Z0-9_-]+)!([a-zA-Z0-9_-]+)/);
    if (legacyFileMatch) {
      return { type: 'file', id: legacyFileMatch[1], key: legacyFileMatch[2], rawUrl: urlStr };
    }

    // Check folder links: mega.nz/folder/ROOT_ID#ROOT_KEY or legacy mega.nz/#F!ROOT_ID!ROOT_KEY
    const folderMatch = urlStr.match(/mega\.nz\/(?:#F!)?folder\/([a-zA-Z0-9_-]+)#([a-zA-Z0-9_-]+)(\/folder\/[a-zA-Z0-9_-]+|\/file\/[a-zA-Z0-9_-]+)?/);
    
    if (folderMatch) {
      const rootId = folderMatch[1];
      const rootKey = folderMatch[2];
      const extraPath = folderMatch[3] || '';

      let targetSubfolderId = null;
      let targetFileId = null;

      if (extraPath.startsWith('/folder/')) {
        targetSubfolderId = extraPath.replace('/folder/', '');
      } else if (extraPath.startsWith('/file/')) {
        targetFileId = extraPath.replace('/file/', '');
      }

      return {
        type: 'folder',
        rootId,
        rootKey,
        targetSubfolderId,
        targetFileId,
        rawUrl: urlStr
      };
    }

    const legacyFolderMatch = urlStr.match(/mega\.nz\/#F!([a-zA-Z0-9_-]+)!([a-zA-Z0-9_-]+)/);
    if (legacyFolderMatch) {
      return {
        type: 'folder',
        rootId: legacyFolderMatch[1],
        rootKey: legacyFolderMatch[2],
        targetSubfolderId: null,
        targetFileId: null,
        rawUrl: urlStr
      };
    }

    return null;
  } catch (err) {
    console.error('[URL PARSE ERROR]', err);
    return null;
  }
}

/**
 * Safe filename sanitizer to prevent path traversal attacks.
 */
function sanitizeFilename(filename) {
  if (!filename) return 'unnamed_file';
  let safe = path.basename(filename);
  safe = safe.replace(/[/\\?%*:|"<>]/g, '_');
  return safe || 'unnamed_file';
}

/**
 * Format bytes to readable string.
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Safely access children of a folder node in megajs 1.3.10.
 */
async function loadFolderContents(folderNode) {
  if (!folderNode.directory) {
    throw new Error('Node is not a directory');
  }
  return Array.isArray(folderNode.children) ? folderNode.children : [];
}

/**
 * Get an identifier for a megajs node.
 */
function getNodeId(node) {
  if (!node) return null;
  return node.downloadId || node.id || node.nodeId || null;
}

/**
 * Recursively find node by ID in loaded megajs folder tree.
 */
function findNodeById(currentNode, targetId) {
  if (!currentNode || !targetId) return null;
  const currentId = getNodeId(currentNode);
  if (currentId === targetId) {
    return currentNode;
  }
  if (currentNode.children && Array.isArray(currentNode.children)) {
    for (const child of currentNode.children) {
      const found = findNodeById(child, targetId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Build parent stack path from root to target folder node.
 */
function buildPathToNode(rootNode, targetNode) {
  const pathArr = [];

  function dfs(curr, target) {
    if (!curr) return false;
    if (curr === target || getNodeId(curr) === getNodeId(target)) {
      return true;
    }
    if (curr.children && Array.isArray(curr.children)) {
      for (const child of curr.children) {
        if (child.directory) {
          pathArr.push({
            id: getNodeId(curr) || 'Folder',
            name: curr.name || 'Folder',
            node: curr
          });
          if (dfs(child, target)) return true;
          pathArr.pop();
        }
      }
    }
    return false;
  }

  dfs(rootNode, targetNode);
  return pathArr;
}

/**
 * Recursively collect all files under a folder node.
 */
async function collectAllFiles(node) {
  let files = [];
  if (!node.directory) {
    files.push(node);
  } else {
    const children = await loadFolderContents(node);
    for (const child of children) {
      if (child.directory) {
        const subFiles = await collectAllFiles(child);
        files = files.concat(subFiles);
      } else {
        files.push(child);
      }
    }
  }
  return files;
}

/**
 * Safely edit message with plain text.
 */
async function safeEditMessage(ctx, text, extra = {}) {
  try {
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      await ctx.telegram.editMessageText(
        ctx.callbackQuery.message.chat.id,
        ctx.callbackQuery.message.message_id,
        null,
        text,
        extra
      );
    } else {
      await ctx.reply(text, extra);
    }
  } catch (err) {
    // Suppress "message is not modified" error from Telegram
    if (!err.description || !err.description.includes('message is not modified')) {
      console.error('[EDIT MSG ERROR]', err.message);
    }
  }
}

// --- BOT COMMANDS & HANDLERS ---

bot.start(async (ctx) => {
  const session = getSession(ctx.from.id);
  session.reset();
  const text = 
    `🤖 MEGA Downloader Bot\n\n` +
    `Send me a public MEGA folder or file link to browse and download files directly to Telegram.\n\n` +
    `Commands:\n` +
    `/cancel - Stop current download or clear session\n` +
    `/help - View help information`;
  await ctx.reply(text);
});

bot.help(async (ctx) => {
  const text = 
    `ℹ️ How to use MEGA Downloader:\n\n` +
    `1. Paste a public MEGA link (file or folder).\n` +
    `2. Browse subfolders using interactive buttons.\n` +
    `3. Select individual files or click "Download All".\n` +
    `4. Downloads are uploaded directly to your chat.\n\n` +
    `Note: Large files will be uploaded according to Telegram limits. If an upload fails due to Telegram limit, you will be notified.`;
  await ctx.reply(text);
});

bot.command('cancel', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (session.activeJob) {
    session.cancelActiveJob();
    await ctx.reply('❌ Current download/upload task has been cancelled.');
  } else {
    session.reset();
    await ctx.reply('❌ Browsing session cleared.');
  }
});

// Main link listener
bot.on('text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return next();

  const parsed = parseMegaUrl(text);
  if (!parsed) {
    return next();
  }

  const session = getSession(ctx.from.id);
  session.reset();

  const statusMsg = await ctx.reply('🔎 Checking MEGA link...');

  try {
    if (parsed.type === 'file') {
      // Single file direct link
      console.log(`[MEGA] Loading file link: ${parsed.id}`);
      const fileNode = MegaFile.fromURL(parsed.rawUrl);
      
      await new Promise((resolve, reject) => {
        fileNode.loadAttributes((err, file) => {
          if (err) return reject(err);
          resolve(file);
        });
      });

      session.rootNode = fileNode;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('⬇️ Download', `dl_single_file`)],
        [Markup.button.callback('❌ Cancel', `cancel_session`)]
      ]);

      const sizeStr = formatBytes(fileNode.size);
      const textResponse = 
        `✅ File found\n\n` +
        `📄 ${fileNode.name}\n` +
        `📦 Size: ${sizeStr}`;

      await ctx.telegram.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        null,
        textResponse,
        keyboard
      );

    } else if (parsed.type === 'folder') {
      console.log(`[MEGA] Loading folder link rootId: ${parsed.rootId}`);
      
      // Reconstruct clean folder root URL
      const cleanRootUrl = `https://mega.nz/folder/${parsed.rootId}#${parsed.rootKey}`;
      const folderNode = MegaFile.fromURL(cleanRootUrl);

      // Load entire folder structure recursively using megajs 1.3.10 loadAttributes
      await new Promise((resolve, reject) => {
        folderNode.loadAttributes((err, loadedFolder) => {
          if (err) return reject(err);
          resolve(loadedFolder);
        });
      });

      session.rootNode = folderNode;
      let activeFolder = folderNode;

      // Handle Direct Subfolder Link if present
      if (parsed.targetSubfolderId) {
        console.log(`[MEGA] Resolving direct subfolder target: ${parsed.targetSubfolderId}`);
        const foundSub = findNodeById(folderNode, parsed.targetSubfolderId);
        if (foundSub && foundSub.directory) {
          activeFolder = foundSub;
          // Dynamically build path stack from root to target subfolder
          session.pathStack = buildPathToNode(folderNode, foundSub);
        } else {
          await ctx.telegram.editMessageText(
            statusMsg.chat.id,
            statusMsg.message_id,
            null,
            `⚠️ Could not resolve requested subfolder ID (${parsed.targetSubfolderId}) inside the provided MEGA folder.`
          );
          return;
        }
      } else if (parsed.targetFileId) {
        console.log(`[MEGA] Resolving direct target file: ${parsed.targetFileId}`);
        const foundFile = findNodeById(folderNode, parsed.targetFileId);
        if (foundFile) {
          const fid = getNodeId(foundFile);
          if (fid) session.selectedIds.add(fid);
        }
      }

      session.currentFolder = activeFolder;
      await renderBrowserUI(ctx, statusMsg.message_id);
    }
  } catch (err) {
    console.error('[MEGA LOAD ERROR]', err);
    await ctx.telegram.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      null,
      `❌ Error loading MEGA link: ${err.message || 'Invalid or inaccessible link.'}`
    );
  }
});

/**
 * Render/update the main inline keyboard folder browser.
 */
async function renderBrowserUI(ctx, editMessageId = null) {
  const session = getSession(ctx.from.id);
  const folder = session.currentFolder;

  if (!folder) {
    return ctx.reply('❌ No active session. Send a new MEGA link.');
  }

  let children = [];
  try {
    children = await loadFolderContents(folder);
  } catch (err) {
    console.error('[LOAD CONTENTS ERROR]', err);
    return safeEditMessage(ctx, `❌ Failed to read folder contents: ${err.message}`);
  }

  // Distinguish folders and files, sort folders first
  const foldersList = children.filter(c => c.directory);
  const filesList = children.filter(c => !c.directory);

  const combinedItems = [...foldersList, ...filesList];
  const totalItems = combinedItems.length;
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;

  if (session.page >= totalPages) session.page = totalPages - 1;
  if (session.page < 0) session.page = 0;

  const startIndex = session.page * ITEMS_PER_PAGE;
  const pageItems = combinedItems.slice(startIndex, startIndex + ITEMS_PER_PAGE);

  const buttons = [];

  // Item List Buttons
  for (const item of pageItems) {
    const itemId = getNodeId(item);
    if (item.directory) {
      buttons.push([Markup.button.callback(`📂 ${item.name}`, `nav_folder_${itemId}`)]);
    } else {
      const isSelected = session.selectedIds.has(itemId);
      const mark = isSelected ? '☑' : '☐';
      const size = formatBytes(item.size);
      buttons.push([Markup.button.callback(`${mark} ${item.name} (${size})`, `toggle_file_${itemId}`)]);
    }
  }

  // Action Bar Buttons
  const controlRow1 = [];
  if (filesList.length > 0) {
    controlRow1.push(Markup.button.callback('☑ Select All Here', `action_select_all_here`));
  }
  if (session.selectedIds.size > 0) {
    controlRow1.push(Markup.button.callback(`⬇️ Download Selected (${session.selectedIds.size})`, `action_dl_selected`));
  }

  if (controlRow1.length > 0) buttons.push(controlRow1);

  const controlRow2 = [];
  controlRow2.push(Markup.button.callback('⬇️ Download All', `action_dl_all`));
  controlRow2.push(Markup.button.callback('📦 Download This Folder', `action_dl_folder`));
  buttons.push(controlRow2);

  // Pagination Row
  if (totalPages > 1) {
    const navRow = [];
    if (session.page > 0) {
      navRow.push(Markup.button.callback('◀️ Prev', `page_${session.page - 1}`));
    }
    navRow.push(Markup.button.callback(`Page ${session.page + 1}/${totalPages}`, `noop`));
    if (session.page < totalPages - 1) {
      navRow.push(Markup.button.callback('Next ▶️', `page_${session.page + 1}`));
    }
    buttons.push(navRow);
  }

  // Navigation History Buttons
  const navBackRow = [];
  if (session.pathStack.length > 0) {
    navBackRow.push(Markup.button.callback('⬅️ Back', `nav_back`));
    navBackRow.push(Markup.button.callback('🏠 Root', `nav_root`));
  }
  navBackRow.push(Markup.button.callback('❌ Cancel', `cancel_session`));
  buttons.push(navBackRow);

  const folderName = folder.name || 'ROOT';
  const headerText = 
    `📁 ${folderName}\n\n` +
    `Folders: ${foldersList.length} | Files: ${filesList.length}\n` +
    (session.selectedIds.size > 0 ? `Selected Files: ${session.selectedIds.size}\n` : '');

  const markup = Markup.inlineKeyboard(buttons);

  if (editMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, editMessageId, null, headerText, markup);
  } else if (ctx.callbackQuery && ctx.callbackQuery.message) {
    await ctx.telegram.editMessageText(
      ctx.callbackQuery.message.chat.id,
      ctx.callbackQuery.message.message_id,
      null,
      headerText,
      markup
    );
  } else {
    await ctx.reply(headerText, markup);
  }
}

// --- CALLBACK QUERY HANDLERS ---

bot.action('noop', async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action('cancel_session', async (ctx) => {
  await ctx.answerCbQuery('Session cancelled');
  const session = getSession(ctx.from.id);
  session.reset();
  await safeEditMessage(ctx, '❌ Browsing session cancelled.');
});

bot.action(/^page_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const page = parseInt(ctx.match[1], 10);
  const session = getSession(ctx.from.id);
  session.page = page;
  await renderBrowserUI(ctx);
});

bot.action(/^nav_folder_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const targetId = ctx.match[1];
  const session = getSession(ctx.from.id);

  if (!session.currentFolder) {
    return ctx.reply('❌ Session expired. Send link again.');
  }

  const children = await loadFolderContents(session.currentFolder);
  const targetFolder = children.find(c => getNodeId(c) === targetId && c.directory);

  if (!targetFolder) {
    return ctx.reply('❌ Folder not found or inaccessible.');
  }

  // Push current folder to path stack
  session.pathStack.push({
    id: getNodeId(session.currentFolder) || 'Folder',
    name: session.currentFolder.name || 'Folder',
    node: session.currentFolder
  });

  session.currentFolder = targetFolder;
  session.page = 0;
  await renderBrowserUI(ctx);
});

bot.action('nav_back', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);

  if (session.pathStack.length > 0) {
    const parent = session.pathStack.pop();
    session.currentFolder = parent.node;
    session.page = 0;
    await renderBrowserUI(ctx);
  } else {
    await ctx.reply('Already at root folder.');
  }
});

bot.action('nav_root', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  if (session.rootNode) {
    session.currentFolder = session.rootNode;
    session.pathStack = [];
    session.page = 0;
    await renderBrowserUI(ctx);
  }
});

bot.action(/^toggle_file_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const fileId = ctx.match[1];
  const session = getSession(ctx.from.id);

  if (session.selectedIds.has(fileId)) {
    session.selectedIds.delete(fileId);
  } else {
    session.selectedIds.add(fileId);
  }

  await renderBrowserUI(ctx);
});

bot.action('action_select_all_here', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  if (!session.currentFolder) return;

  const children = await loadFolderContents(session.currentFolder);
  const filesList = children.filter(c => !c.directory);

  const allHereSelected = filesList.every(f => session.selectedIds.has(getNodeId(f)));

  for (const file of filesList) {
    const fid = getNodeId(file);
    if (!fid) continue;
    if (allHereSelected) {
      session.selectedIds.delete(fid);
    } else {
      session.selectedIds.add(fid);
    }
  }

  await renderBrowserUI(ctx);
});

// Download Handlers
bot.action('dl_single_file', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  if (!session.rootNode) return ctx.reply('❌ No file ready.');
  
  await executeBatchDownload(ctx, [session.rootNode]);
});

bot.action('action_dl_selected', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  if (!session.currentFolder) return;

  const allFiles = await collectAllFiles(session.rootNode || session.currentFolder);
  const selectedFiles = allFiles.filter(f => session.selectedIds.has(getNodeId(f)));

  if (selectedFiles.length === 0) {
    return ctx.reply('⚠️ No files selected.');
  }

  await executeBatchDownload(ctx, selectedFiles);
});

bot.action('action_dl_folder', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  if (!session.currentFolder) return;

  const statusMsg = await ctx.reply('📦 Scanning folder files recursively...');
  const files = await collectAllFiles(session.currentFolder);

  if (files.length === 0) {
    return ctx.telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, null, '⚠️ No files found in this folder.');
  }

  await executeBatchDownload(ctx, files, statusMsg.message_id);
});

bot.action('action_dl_all', async (ctx) => {
  await ctx.answerCbQuery();
  const session = getSession(ctx.from.id);
  const targetRoot = session.rootNode || session.currentFolder;
  if (!targetRoot) return;

  const statusMsg = await ctx.reply('📦 Scanning all files recursively...');
  const files = await collectAllFiles(targetRoot);

  if (files.length === 0) {
    return ctx.telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, null, '⚠️ No downloadable files found.');
  }

  await executeBatchDownload(ctx, files, statusMsg.message_id);
});

// --- CORE DOWNLOAD & UPLOAD PIPELINE ---

/**
 * Sequential execution of batch file downloads with progress monitoring.
 */
async function executeBatchDownload(ctx, fileNodes, existingMsgId = null) {
  const session = getSession(ctx.from.id);

  if (session.activeJob) {
    return ctx.reply('⚠️ A download task is already running. Use /cancel to stop it.');
  }

  let statusMsg;
  if (existingMsgId) {
    statusMsg = { chat: { id: ctx.chat.id }, message_id: existingMsgId };
  } else if (ctx.callbackQuery && ctx.callbackQuery.message) {
    statusMsg = ctx.callbackQuery.message;
  } else {
    statusMsg = await ctx.reply('🚀 Starting download job...');
  }

  session.activeJob = {
    cancelled: false,
    stream: null,
    tempFilePath: null,
    messageId: statusMsg.message_id
  };

  const totalFiles = fileNodes.length;
  let successfulCount = 0;
  const failedFiles = [];

  console.log(`[DOWNLOAD BATCH] Total files: ${totalFiles} for user: ${ctx.from.id}`);

  for (let i = 0; i < totalFiles; i++) {
    if (session.activeJob && session.activeJob.cancelled) {
      console.log(`[DOWNLOAD BATCH] Cancelled at file ${i + 1}/${totalFiles}`);
      break;
    }

    const node = fileNodes[i];
    const rawName = node.name || `file_${i + 1}`;
    const safeName = sanitizeFilename(rawName);
    const sizeStr = formatBytes(node.size);

    await updateProgressMessage(
      ctx,
      statusMsg.message_id,
      `⬇️ Downloading (${i + 1}/${totalFiles})\n\n🎬 ${safeName}\n📦 Size: ${sizeStr}\nProgress: 0%`
    );

    const tempFilePath = path.join(TEMP_DIR, `${Date.now()}_${safeName}`);
    session.activeJob.tempFilePath = tempFilePath;

    try {
      // 1. Download file from MEGA
      await new Promise((resolve, reject) => {
        const downloadStream = node.download();
        session.activeJob.stream = downloadStream;

        const writeStream = fs.createWriteStream(tempFilePath);

        let downloadedBytes = 0;
        let lastProgressTime = 0;

        downloadStream.on('data', (chunk) => {
          if (session.activeJob && session.activeJob.cancelled) {
            downloadStream.destroy();
            writeStream.destroy();
            return reject(new Error('USER_CANCELLED'));
          }
          downloadedBytes += chunk.length;
          const now = Date.now();
          // Throttle status updates per user session
          if (now - lastProgressTime > 2500 && node.size > 0) {
            lastProgressTime = now;
            const percent = Math.min(100, Math.floor((downloadedBytes / node.size) * 100));
            updateProgressMessage(
              ctx,
              statusMsg.message_id,
              `⬇️ Downloading (${i + 1}/${totalFiles})\n\n🎬 ${safeName}\n📦 Size: ${sizeStr}\nProgress: ${percent}%`
            ).catch(() => {});
          }
        });

        downloadStream.on('error', (err) => {
          writeStream.destroy();
          reject(err);
        });

        writeStream.on('error', (err) => reject(err));
        writeStream.on('finish', () => resolve());

        downloadStream.pipe(writeStream);
      });

      if (session.activeJob && session.activeJob.cancelled) {
        throw new Error('USER_CANCELLED');
      }

      // 2. Upload file to Telegram
      await updateProgressMessage(
        ctx,
        statusMsg.message_id,
        `📤 Uploading (${i + 1}/${totalFiles})\n\n🎬 ${safeName}\n📦 Size: ${sizeStr}`
      );

      await uploadFileToTelegram(ctx, tempFilePath, safeName);
      successfulCount++;

    } catch (err) {
      if (err.message === 'USER_CANCELLED') {
        console.log(`[DOWNLOAD] Cancelled by user: ${safeName}`);
        cleanupTempFile(tempFilePath);
        break;
      }

      console.error(`[DOWNLOAD/UPLOAD ERROR] File: ${safeName}`, err);
      failedFiles.push(`${safeName} (${err.message || 'Unknown error'})`);
    } finally {
      cleanupTempFile(tempFilePath);
      if (session.activeJob) {
        session.activeJob.tempFilePath = null;
        session.activeJob.stream = null;
      }
    }
  }

  // Final summary
  const wasCancelled = session.activeJob && session.activeJob.cancelled;
  session.activeJob = null;

  if (wasCancelled) {
    await updateProgressMessage(ctx, statusMsg.message_id, '❌ Task was cancelled.');
    return;
  }

  let finalReport = `✅ Download complete\n\n${totalFiles} files processed\n${successfulCount} successful\n${failedFiles.length} failed`;
  if (failedFiles.length > 0) {
    finalReport = `⚠️ Download completed with errors\n\n${successfulCount} successful\n${failedFiles.length} failed:\n` +
      failedFiles.slice(0, 5).map(f => `• ${f}`).join('\n');
  }

  await updateProgressMessage(ctx, statusMsg.message_id, finalReport);
}

/**
 * Intelligent Telegram uploader with fallback to document on error.
 */
async function uploadFileToTelegram(ctx, filePath, filename) {
  const mimeType = mime.lookup(filename) || 'application/octet-stream';
  const fileInput = { source: filePath, filename: filename };

  try {
    if (mimeType.startsWith('video/')) {
      await ctx.replyWithVideo(fileInput, { caption: filename });
    } else if (mimeType.startsWith('image/')) {
      await ctx.replyWithPhoto(fileInput, { caption: filename });
    } else if (mimeType.startsWith('audio/')) {
      await ctx.replyWithAudio(fileInput, { caption: filename });
    } else {
      await ctx.replyWithDocument(fileInput, { caption: filename });
    }
  } catch (mediaErr) {
    console.warn(`[UPLOAD FALLBACK] Media upload failed for ${filename}, sending as document:`, mediaErr.message);
    try {
      // Fallback cleanly to Document mode
      await ctx.replyWithDocument(fileInput, { caption: filename });
    } catch (docErr) {
      if (docErr.description && docErr.description.includes('file is too large')) {
        throw new Error('Telegram file size limit exceeded');
      }
      throw docErr;
    }
  }
}

/**
 * Safe per-user message updater for download/upload progress.
 */
async function updateProgressMessage(ctx, messageId, text) {
  const session = getSession(ctx.from.id);
  const now = Date.now();

  // Enforce 1.5s throttle per user session
  if (now - session.lastMsgEditTime < 1500) return;
  session.lastMsgEditTime = now;

  try {
    await ctx.telegram.editMessageText(ctx.chat.id, messageId, null, text);
  } catch (err) {
    if (!err.description || !err.description.includes('message is not modified')) {
      console.error('[PROGRESS EDIT ERROR]', err.message);
    }
  }
}

/**
 * Clean up local temporary file safely.
 */
function cleanupTempFile(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.removeSync(filePath);
      console.log(`[CLEANUP] Removed temp file: ${filePath}`);
    } catch (err) {
      console.error(`[CLEANUP ERROR] ${filePath}`, err.message);
    }
  }
}

// --- GLOBAL ERROR HANDLING & SHUTDOWN ---

bot.catch((err, ctx) => {
  console.error(`[TELEGRAF ERROR] for ${ctx.updateType}`, err);
  ctx.reply('❌ An unexpected error occurred while processing your request.').catch(() => {});
});

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

function gracefulShutdown(signal) {
  console.log(`\n[SHUTDOWN] Received ${signal}. Cleaning up sessions and stopping bot...`);
  for (const session of userSessions.values()) {
    session.cancelActiveJob();
  }
  bot.stop(signal);
  try {
    fs.removeSync(TEMP_DIR);
  } catch (_) {}
  process.exit(0);
}

// Start Bot
bot.launch().then(() => {
  console.log('🤖 MEGA Downloader Bot is running successfully!');
});
