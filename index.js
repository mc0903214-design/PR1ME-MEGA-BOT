const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const crypto = require('crypto');

const { Telegraf, Markup } = require('telegraf');
const { File: MegaFile } = require('megajs');
const mime = require('mime-types');

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('[CRITICAL] BOT_TOKEN environment variable is missing.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const TEMP_DIR = path.join(os.tmpdir(), 'telegram-mega-downloader');

fs.ensureDirSync(TEMP_DIR);

const ITEMS_PER_PAGE = 8;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const PROGRESS_EDIT_INTERVAL_MS = 1500;
const DOWNLOAD_PROGRESS_INTERVAL_MS = 2500;

// ============================================================
// SESSION STORAGE
// ============================================================

const userSessions = new Map();

class UserSession {
  constructor(userId) {
    this.userId = userId;

    // MEGA state
    this.rootNode = null;
    this.currentFolder = null;

    // Navigation
    this.pathStack = [];

    // Selected files
    this.selectedIds = new Set();

    // Pagination
    this.page = 0;

    // Active download job
    this.activeJob = null;

    // Activity
    this.lastActivity = Date.now();

    // Telegram progress editing
    this.lastMsgEditTime = 0;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  resetBrowser() {
    this.rootNode = null;
    this.currentFolder = null;
    this.pathStack = [];
    this.selectedIds.clear();
    this.page = 0;
  }

  cancelActiveJob() {
    const job = this.activeJob;

    if (!job) {
      return false;
    }

    // IMPORTANT:
    // Do NOT immediately set this.activeJob = null.
    // The running download function needs the same job object
    // to see cancelled === true.
    job.cancelled = true;

    if (job.stream && typeof job.stream.destroy === 'function') {
      try {
        job.stream.destroy(new Error('USER_CANCELLED'));
      } catch (_) {}
    }

    if (job.writeStream && typeof job.writeStream.destroy === 'function') {
      try {
        job.writeStream.destroy(new Error('USER_CANCELLED'));
      } catch (_) {}
    }

    if (job.tempFilePath) {
      cleanupTempFile(job.tempFilePath);
    }

    return true;
  }

  reset() {
    this.cancelActiveJob();
    this.resetBrowser();
  }
}

function getSession(userId) {
  let session = userSessions.get(userId);

  if (!session) {
    session = new UserSession(userId);
    userSessions.set(userId, session);
  }

  session.touch();

  return session;
}

// ============================================================
// SESSION GARBAGE COLLECTION
// ============================================================

setInterval(() => {
  const now = Date.now();

  for (const [userId, session] of userSessions.entries()) {
    if (
      now - session.lastActivity > SESSION_TIMEOUT_MS &&
      !session.activeJob
    ) {
      userSessions.delete(userId);
    }
  }
}, 5 * 60 * 1000);

// ============================================================
// GENERAL HELPERS
// ============================================================

function sanitizeFilename(filename) {
  if (!filename) {
    return 'unnamed_file';
  }

  let safe = String(filename);

  safe = path.basename(safe);

  safe = safe.replace(/[\/\\?%*:|"<>]/g, '_');

  safe = safe.replace(/\s+/g, ' ').trim();

  if (!safe || safe === '.' || safe === '..') {
    return 'unnamed_file';
  }

  return safe;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );

  const value = bytes / Math.pow(1024, i);

  return `${parseFloat(value.toFixed(2))} ${units[i]}`;
}

function getNodeId(node) {
  if (!node) {
    return null;
  }

  return (
    node.nodeId ||
    node.downloadId ||
    node.id ||
    null
  );
}

function isDirectory(node) {
  return !!(node && node.directory === true);
}

function getNodeName(node) {
  if (!node) {
    return 'Unnamed';
  }

  return node.name || 'Unnamed';
}

function makeTempFilePath(filename) {
  const safeName = sanitizeFilename(filename);

  const uniqueId = crypto
    .randomBytes(8)
    .toString('hex');

  return path.join(
    TEMP_DIR,
    `${Date.now()}_${uniqueId}_${safeName}`
  );
}

function cleanupTempFile(filePath) {
  if (!filePath) {
    return;
  }

  try {
    if (fs.existsSync(filePath)) {
      fs.removeSync(filePath);
      console.log(`[CLEANUP] Removed: ${filePath}`);
    }
  } catch (err) {
    console.error(
      `[CLEANUP ERROR] ${filePath}`,
      err.message
    );
  }
}

// ============================================================
// MEGA URL HANDLING
// ============================================================

function parseMegaUrl(input) {
  if (!input) {
    return null;
  }

  const rawUrl = String(input).trim();

  if (!rawUrl) {
    return null;
  }

  let url;

  try {
    url = new URL(rawUrl);
  } catch (_) {
    return null;
  }

  const hostname = url.hostname.toLowerCase();

  if (
    hostname !== 'mega.nz' &&
    hostname !== 'mega.co.nz' &&
    hostname !== 'www.mega.nz' &&
    hostname !== 'www.mega.co.nz'
  ) {
    return null;
  }

  const pathname = url.pathname;

  // ----------------------------------------------------------
  // Modern file link
  // https://mega.nz/file/FILE_ID#KEY
  // ----------------------------------------------------------

  const modernFileMatch = pathname.match(
    /^\/file\/([^/]+)$/i
  );

  if (modernFileMatch) {
    return {
      type: 'file',
      rawUrl,
      fileId: modernFileMatch[1],
      key: url.hash ? url.hash.slice(1) : null
    };
  }

  // ----------------------------------------------------------
  // Modern folder link
  // https://mega.nz/folder/ROOT_ID#KEY
  // https://mega.nz/folder/ROOT_ID#KEY/folder/SUB_ID
  // https://mega.nz/folder/ROOT_ID#KEY/file/FILE_ID
  // ----------------------------------------------------------

  const folderMatch = pathname.match(
    /^\/folder\/([^/]+)(?:\/(folder|file)\/([^/]+))?$/i
  );

  if (folderMatch) {
    return {
      type: 'folder',
      rawUrl,
      rootId: folderMatch[1],
      key: url.hash ? url.hash.slice(1).split('/')[0] : null,
      targetType: folderMatch[2]
        ? folderMatch[2].toLowerCase()
        : null,
      targetId: folderMatch[3] || null
    };
  }

  // ----------------------------------------------------------
  // Legacy file link
  // https://mega.nz/#!FILE_ID!KEY
  // ----------------------------------------------------------

  if (pathname === '/#!' || pathname === '/#') {
    return null;
  }

  const hash = url.hash || '';

  const legacyFileMatch = hash.match(
    /^#!([^!]+)!([^/]+)$/i
  );

  if (legacyFileMatch) {
    return {
      type: 'file',
      rawUrl,
      fileId: legacyFileMatch[1],
      key: legacyFileMatch[2]
    };
  }

  // ----------------------------------------------------------
  // Legacy folder link
  // https://mega.nz/#F!ROOT_ID!KEY
  // ----------------------------------------------------------

  const legacyFolderMatch = hash.match(
    /^#F!([^!]+)!([^/]+)$/i
  );

  if (legacyFolderMatch) {
    return {
      type: 'folder',
      rawUrl,
      rootId: legacyFolderMatch[1],
      key: legacyFolderMatch[2],
      targetType: null,
      targetId: null
    };
  }

  // ----------------------------------------------------------
  // Last-resort validation for MEGA URLs.
  // Let MEGAJS handle unusual supported formats.
  // ----------------------------------------------------------

  if (
    rawUrl.includes('mega.nz/') ||
    rawUrl.includes('mega.co.nz/')
  ) {
    return {
      type: 'unknown',
      rawUrl
    };
  }

  return null;
}

// ============================================================
// MEGA LOADING
// ============================================================

async function loadMegaNode(url) {
  const node = MegaFile.fromURL(url);

  const loaded = await node.loadAttributes();

  return {
    node,
    loaded: loaded || node
  };
}

/**
 * Load a public MEGA folder.
 *
 * The returned folder object must have children after
 * loadAttributes().
 */
async function loadMegaFolder(url) {
  const folder = MegaFile.fromURL(url);

  await folder.loadAttributes();

  if (!folder.directory) {
    throw new Error('MEGA link did not resolve to a folder.');
  }

  if (!Array.isArray(folder.children)) {
    throw new Error(
      'MEGA folder contents could not be loaded.'
    );
  }

  return folder;
}

// ============================================================
// FOLDER TREE HELPERS
// ============================================================

function getChildren(folder) {
  if (!folder || !isDirectory(folder)) {
    return [];
  }

  if (!Array.isArray(folder.children)) {
    return [];
  }

  return folder.children;
}

function findNodeById(root, targetId) {
  if (!root || !targetId) {
    return null;
  }

  const rootId = getNodeId(root);

  if (rootId === targetId) {
    return root;
  }

  const children = getChildren(root);

  for (const child of children) {
    const childId = getNodeId(child);

    if (childId === targetId) {
      return child;
    }

    if (isDirectory(child)) {
      const found = findNodeById(child, targetId);

      if (found) {
        return found;
      }
    }
  }

  return null;
}

/**
 * Build navigation path from root to target.
 *
 * The returned array contains the parent folders that should
 * appear in Back navigation.
 */
function buildPathToNode(root, target) {
  if (!root || !target) {
    return [];
  }

  if (root === target) {
    return [];
  }

  const targetId = getNodeId(target);

  function search(current, parents) {
    if (!current) {
      return null;
    }

    const currentId = getNodeId(current);

    if (
      current === target ||
      (targetId && currentId === targetId)
    ) {
      return parents;
    }

    for (const child of getChildren(current)) {
      if (!isDirectory(child)) {
        continue;
      }

      const result = search(
        child,
        [
          ...parents,
          {
            id: getNodeId(current),
            name: getNodeName(current),
            node: current
          }
        ]
      );

      if (result) {
        return result;
      }
    }

    return null;
  }

  return search(root, []) || [];
}

async function collectAllFiles(node) {
  if (!node) {
    return [];
  }

  if (!isDirectory(node)) {
    return [node];
  }

  const children = getChildren(node);

  const result = [];

  for (const child of children) {
    if (isDirectory(child)) {
      const nested = await collectAllFiles(child);
      result.push(...nested);
    } else {
      result.push(child);
    }
  }

  return result;
}

// ============================================================
// TELEGRAM MESSAGE HELPERS
// ============================================================

async function safeEditMessage(
  ctx,
  text,
  extra = {}
) {
  try {
    if (
      ctx.callbackQuery &&
      ctx.callbackQuery.message
    ) {
      await ctx.telegram.editMessageText(
        ctx.callbackQuery.message.chat.id,
        ctx.callbackQuery.message.message_id,
        undefined,
        text,
        extra
      );

      return;
    }

    await ctx.reply(text, extra);
  } catch (err) {
    if (
      !err.description ||
      !err.description.includes('message is not modified')
    ) {
      console.error(
        '[MESSAGE EDIT ERROR]',
        err.message
      );
    }
  }
}

// ============================================================
// START / HELP / CANCEL
// ============================================================

bot.start(async (ctx) => {
  const session = getSession(ctx.from.id);

  session.reset();

  await ctx.reply(
    [
      '🤖 MEGA Downloader Bot',
      '',
      'Send me a public MEGA file or folder link.',
      '',
      'You can:',
      '• Browse folders',
      '• Open nested folders',
      '• Select individual files',
      '• Download selected files',
      '• Download an entire folder',
      '• Download everything',
      '• Cancel active downloads',
      '',
      'Commands:',
      '/cancel - Cancel download or clear session',
      '/help - Show help'
    ].join('\n')
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
    [
      'ℹ️ MEGA Downloader Help',
      '',
      '1. Send a public MEGA file or folder link.',
      '2. Browse the folder using the buttons.',
      '3. Tap a file to select it.',
      '4. Choose Download Selected, Download All, or Download This Folder.',
      '',
      'Files are downloaded from MEGA to temporary storage and then uploaded to Telegram.',
      '',
      'Use /cancel at any time to cancel an active download.'
    ].join('\n')
  );
});

bot.command('cancel', async (ctx) => {
  const session = getSession(ctx.from.id);

  if (session.activeJob) {
    session.cancelActiveJob();

    await ctx.reply(
      '❌ Current download task has been cancelled.'
    );

    return;
  }

  session.reset();

  await ctx.reply(
    '❌ Current MEGA browsing session has been cleared.'
  );
});

// ============================================================
// MAIN MEGA LINK HANDLER
// ============================================================

bot.on('text', async (ctx, next) => {
  const text = ctx.message.text.trim();

  if (!text || text.startsWith('/')) {
    return next();
  }

  const parsed = parseMegaUrl(text);

  if (!parsed) {
    return next();
  }

  const session = getSession(ctx.from.id);

  // Cancel previous job/session before starting a new one.
  session.reset();

  const statusMsg = await ctx.reply(
    '🔎 Checking MEGA link...'
  );

  try {
    console.log(
      `[MEGA] Incoming URL: ${parsed.rawUrl}`
    );

    // ========================================================
    // DIRECT FILE LINK
    // ========================================================

    if (parsed.type === 'file') {
      const { node, loaded } =
        await loadMegaNode(parsed.rawUrl);

      const actualFile =
        loaded && !isDirectory(loaded)
          ? loaded
          : !isDirectory(node)
            ? node
            : null;

      if (!actualFile) {
        throw new Error(
          'The MEGA link did not resolve to a downloadable file.'
        );
      }

      session.rootNode = actualFile;
      session.currentFolder = null;
      session.pathStack = [];
      session.selectedIds.clear();

      const filename =
        getNodeName(actualFile);

      const size =
        formatBytes(actualFile.size);

      const keyboard =
        Markup.inlineKeyboard([
          [
            Markup.button.callback(
              '⬇️ Download',
              'dl_single_file'
            )
          ],
          [
            Markup.button.callback(
              '❌ Cancel',
              'cancel_session'
            )
          ]
        ]);

      await ctx.telegram.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        undefined,
        [
          '✅ File found',
          '',
          `📄 ${filename}`,
          `📦 Size: ${size}`
        ].join('\n'),
        keyboard
      );

      return;
    }

    // ========================================================
    // FOLDER LINK
    // ========================================================

    let rootFolder;

    if (parsed.type === 'folder') {
      /*
       * Always load the ROOT folder using the actual root ID/key.
       *
       * This gives us a complete tree and lets us resolve
       * /folder/SUB_ID ourselves instead of assuming what
       * File.fromURL() returns for a subfolder target.
       */

      let rootUrl;

      if (parsed.rootId && parsed.key) {
        rootUrl =
          `https://mega.nz/folder/${parsed.rootId}#${parsed.key}`;
      } else {
        // Let MEGAJS attempt to handle unusual supported URLs.
        rootUrl = parsed.rawUrl;
      }

      console.log(
        `[MEGA] Loading root folder: ${rootUrl}`
      );

      rootFolder =
        await loadMegaFolder(rootUrl);
    } else {
      // Unknown but possibly supported MEGA URL.
      const { node, loaded } =
        await loadMegaNode(parsed.rawUrl);

      const actual =
        loaded || node;

      if (!actual) {
        throw new Error(
          'Unable to resolve MEGA link.'
        );
      }

      if (!isDirectory(actual)) {
        session.rootNode = actual;

        const keyboard =
          Markup.inlineKeyboard([
            [
              Markup.button.callback(
                '⬇️ Download',
                'dl_single_file'
              )
            ],
            [
              Markup.button.callback(
                '❌ Cancel',
                'cancel_session'
              )
            ]
          ]);

        await ctx.telegram.editMessageText(
          statusMsg.chat.id,
          statusMsg.message_id,
          undefined,
          [
            '✅ File found',
            '',
            `📄 ${getNodeName(actual)}`,
            `📦 ${formatBytes(actual.size)}`
          ].join('\n'),
          keyboard
        );

        return;
      }

      rootFolder = actual;
    }

    // ========================================================
    // RESOLVE TARGET FOLDER / FILE
    // ========================================================

    session.rootNode = rootFolder;

    let targetFolder = rootFolder;

    if (
      parsed.targetType === 'folder' &&
      parsed.targetId
    ) {
      console.log(
        `[MEGA] Searching for target folder: ${parsed.targetId}`
      );

      const found =
        findNodeById(
          rootFolder,
          parsed.targetId
        );

      if (!found) {
        throw new Error(
          `The requested MEGA subfolder (${parsed.targetId}) could not be found.`
        );
      }

      if (!isDirectory(found)) {
        throw new Error(
          'The requested target is not a folder.'
        );
      }

      targetFolder = found;

      session.pathStack =
        buildPathToNode(
          rootFolder,
          targetFolder
        );
    } else {
      session.pathStack = [];
    }

    if (
      parsed.targetType === 'file' &&
      parsed.targetId
    ) {
      console.log(
        `[MEGA] Searching for target file: ${parsed.targetId}`
      );

      const targetFile =
        findNodeById(
          rootFolder,
          parsed.targetId
        );

      if (!targetFile) {
        throw new Error(
          `The requested MEGA file (${parsed.targetId}) could not be found.`
        );
      }

      if (isDirectory(targetFile)) {
        throw new Error(
          'The requested target is a folder, not a file.'
        );
      }

      session.currentFolder = null;
      session.pathStack = [];
      session.selectedIds.clear();

      const keyboard =
        Markup.inlineKeyboard([
          [
            Markup.button.callback(
              '⬇️ Download',
              'dl_single_file'
            )
          ],
          [
            Markup.button.callback(
              '❌ Cancel',
              'cancel_session'
            )
          ]
        ]);

      await ctx.telegram.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        undefined,
        [
          '✅ File found',
          '',
          `📄 ${getNodeName(targetFile)}`,
          `📦 Size: ${formatBytes(targetFile.size)}`
        ].join('\n'),
        keyboard
      );

      /*
       * IMPORTANT:
       * rootNode becomes the actual file for this direct-target
       * flow so dl_single_file downloads exactly this file.
       */
      session.rootNode = targetFile;

      return;
    }

    session.currentFolder = targetFolder;
    session.page = 0;
    session.selectedIds.clear();

    await renderBrowserUI(
      ctx,
      statusMsg.message_id
    );
  } catch (err) {
    console.error(
      '[MEGA LOAD ERROR]',
      err
    );

    let message =
      err && err.message
        ? err.message
        : 'Invalid or inaccessible MEGA link.';

    if (
      message.toLowerCase().includes('not found')
    ) {
      message =
        'The requested MEGA file or folder could not be found inside the shared folder.';
    }

    await ctx.telegram.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      undefined,
      `❌ Error loading MEGA link:\n\n${message}`
    );
  }
});

// ============================================================
// BROWSER UI
// ============================================================

async function renderBrowserUI(
  ctx,
  editMessageId = null
) {
  const session = getSession(ctx.from.id);

  const folder =
    session.currentFolder;

  if (!folder || !isDirectory(folder)) {
    return safeEditMessage(
      ctx,
      '❌ No active MEGA folder.'
    );
  }

  const children =
    getChildren(folder);

  const folders =
    children
      .filter(isDirectory)
      .sort((a, b) =>
        getNodeName(a).localeCompare(
          getNodeName(b),
          undefined,
          { sensitivity: 'base' }
        )
      );

  const files =
    children
      .filter(child => !isDirectory(child))
      .sort((a, b) =>
        getNodeName(a).localeCompare(
          getNodeName(b),
          undefined,
          { sensitivity: 'base' }
        )
      );

  const combined =
    [...folders, ...files];

  const totalItems =
    combined.length;

  const totalPages =
    Math.max(
      1,
      Math.ceil(
        totalItems / ITEMS_PER_PAGE
      )
    );

  if (session.page >= totalPages) {
    session.page =
      totalPages - 1;
  }

  if (session.page < 0) {
    session.page = 0;
  }

  const start =
    session.page * ITEMS_PER_PAGE;

  const pageItems =
    combined.slice(
      start,
      start + ITEMS_PER_PAGE
    );

  const buttons = [];

  // ----------------------------------------------------------
  // ITEMS
  // ----------------------------------------------------------

  for (const item of pageItems) {
    const id = getNodeId(item);

    if (!id) {
      continue;
    }

    if (isDirectory(item)) {
      buttons.push([
        Markup.button.callback(
          `📂 ${getNodeName(item)}`,
          `nav_folder_${id}`
        )
      ]);
    } else {
      const selected =
        session.selectedIds.has(id);

      const mark =
        selected ? '☑️' : '⬜';

      buttons.push([
        Markup.button.callback(
          `${mark} ${getNodeName(item)} (${formatBytes(item.size)})`,
          `toggle_file_${id}`
        )
      ]);
    }
  }

  // ----------------------------------------------------------
  // SELECT / DOWNLOAD SELECTED
  // ----------------------------------------------------------

  const row1 = [];

  if (files.length > 0) {
    row1.push(
      Markup.button.callback(
        '☑️ Select All Here',
        'action_select_all_here'
      )
    );
  }

  if (session.selectedIds.size > 0) {
    row1.push(
      Markup.button.callback(
        `⬇️ Selected (${session.selectedIds.size})`,
        'action_dl_selected'
      )
    );
  }

  if (row1.length > 0) {
    buttons.push(row1);
  }

  // ----------------------------------------------------------
  // DOWNLOAD CONTROLS
  // ----------------------------------------------------------

  buttons.push([
    Markup.button.callback(
      '⬇️ Download All',
      'action_dl_all'
    ),
    Markup.button.callback(
      '📦 This Folder',
      'action_dl_folder'
    )
  ]);

  // ----------------------------------------------------------
  // PAGINATION
  // ----------------------------------------------------------

  if (totalPages > 1) {
    const pagination = [];

    if (session.page > 0) {
      pagination.push(
        Markup.button.callback(
          '◀️ Prev',
          `page_${session.page - 1}`
        )
      );
    }

    pagination.push(
      Markup.button.callback(
        `Page ${session.page + 1}/${totalPages}`,
        'noop'
      )
    );

    if (session.page < totalPages - 1) {
      pagination.push(
        Markup.button.callback(
          'Next ▶️',
          `page_${session.page + 1}`
        )
      );
    }

    buttons.push(pagination);
  }

  // ----------------------------------------------------------
  // NAVIGATION
  // ----------------------------------------------------------

  const navigation = [];

  if (session.pathStack.length > 0) {
    navigation.push(
      Markup.button.callback(
        '⬅️ Back',
        'nav_back'
      )
    );

    navigation.push(
      Markup.button.callback(
        '🏠 Root',
        'nav_root'
      )
    );
  }

  navigation.push(
    Markup.button.callback(
      '❌ Cancel',
      'cancel_session'
    )
  );

  buttons.push(navigation);

  // ----------------------------------------------------------
  // HEADER
  // ----------------------------------------------------------

  const header = [
    `📁 ${getNodeName(folder)}`,
    '',
    `📂 Folders: ${folders.length}`,
    `📄 Files: ${files.length}`,
    `📑 Page: ${session.page + 1}/${totalPages}`
  ];

  if (session.selectedIds.size > 0) {
    header.push(
      `☑️ Selected: ${session.selectedIds.size}`
    );
  }

  const text =
    header.join('\n');

  const markup =
    Markup.inlineKeyboard(buttons);

  try {
    if (editMessageId) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        editMessageId,
        undefined,
        text,
        markup
      );
    } else if (
      ctx.callbackQuery &&
      ctx.callbackQuery.message
    ) {
      await ctx.telegram.editMessageText(
        ctx.callbackQuery.message.chat.id,
        ctx.callbackQuery.message.message_id,
        undefined,
        text,
        markup
      );
    } else {
      await ctx.reply(
        text,
        markup
      );
    }
  } catch (err) {
    if (
      !err.description ||
      !err.description.includes(
        'message is not modified'
      )
    ) {
      console.error(
        '[BROWSER UI ERROR]',
        err.message
      );
    }
  }
}

// ============================================================
// CALLBACK: NOOP
// ============================================================

bot.action('noop', async (ctx) => {
  await ctx.answerCbQuery();
});

// ============================================================
// CALLBACK: CANCEL
// ============================================================

bot.action(
  'cancel_session',
  async (ctx) => {
    await ctx.answerCbQuery(
      'Session cancelled'
    );

    const session =
      getSession(ctx.from.id);

    session.reset();

    await safeEditMessage(
      ctx,
      '❌ MEGA session cancelled.'
    );
  }
);

// ============================================================
// CALLBACK: PAGINATION
// ============================================================

bot.action(
  /^page_(\d+)$/,
  async (ctx) => {
    await ctx.answerCbQuery();

    const page =
      Number.parseInt(
        ctx.match[1],
        10
      );

    const session =
      getSession(ctx.from.id);

    session.page =
      Number.isFinite(page)
        ? page
        : 0;

    await renderBrowserUI(ctx);
  }
);

// ============================================================
// CALLBACK: OPEN FOLDER
// ============================================================

bot.action(
  /^nav_folder_(.+)$/,
  async (ctx) => {
    await ctx.answerCbQuery();

    const targetId =
      ctx.match[1];

    const session =
      getSession(ctx.from.id);

    const current =
      session.currentFolder;

    if (!current) {
      return ctx.reply(
        '❌ Session expired. Please send the MEGA link again.'
      );
    }

    const target =
      getChildren(current).find(
        child =>
          isDirectory(child) &&
          getNodeId(child) === targetId
      );

    if (!target) {
      return ctx.reply(
        '❌ Folder not found or inaccessible.'
      );
    }

    session.pathStack.push({
      id: getNodeId(current),
      name: getNodeName(current),
      node: current
    });

    session.currentFolder =
      target;

    session.page = 0;

    await renderBrowserUI(ctx);
  }
);

// ============================================================
// CALLBACK: BACK
// ============================================================

bot.action(
  'nav_back',
  async (ctx) => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    if (
      session.pathStack.length === 0
    ) {
      return renderBrowserUI(ctx);
    }

    const parent =
      session.pathStack.pop();

    session.currentFolder =
      parent.node;

    session.page = 0;

    await renderBrowserUI(ctx);
  }
);

// ============================================================
// CALLBACK: ROOT
// ============================================================

bot.action(
  'nav_root',
  async (ctx) => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    if (
      !session.rootNode ||
      !isDirectory(session.rootNode)
    ) {
      return ctx.reply(
        '❌ Root folder is no longer available.'
      );
    }

    session.currentFolder =
      session.rootNode;

    session.pathStack = [];

    session.page = 0;

    await renderBrowserUI(ctx);
  }
);

// ============================================================
// CALLBACK: TOGGLE FILE
// ============================================================

bot.action(
  /^toggle_file_(.+)$/,
  async (ctx) => {
    await ctx.answerCbQuery();

    const fileId =
      ctx.match[1];

    const session =
      getSession(ctx.from.id);

    if (
      session.selectedIds.has(fileId)
    ) {
      session.selectedIds.delete(
        fileId
      );
    } else {
      session.selectedIds.add(
        fileId
      );
    }

    await renderBrowserUI(ctx);
  }
);

// ============================================================
// CALLBACK: SELECT ALL HERE
// ============================================================

bot.action(
  'action_select_all_here',
  async (ctx) => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    if (!session.currentFolder) {
      return;
    }

    const files =
      getChildren(
        session.currentFolder
      ).filter(
        child => !isDirectory(child)
      );

    if (files.length === 0) {
      return;
    }

    const allSelected =
      files.every(file =>
        session.selectedIds.has(
          getNodeId(file)
        )
      );

    for (const file of files) {
      const id =
        getNodeId(file);

      if (!id) {
        continue;
      }

      if (allSelected) {
        session.selectedIds.delete(id);
      } else {
        session.selectedIds.add(id);
      }
    }

    await renderBrowserUI(ctx);
  }
);

// ============================================================
// CALLBACK: DIRECT FILE DOWNLOAD
// ============================================================

bot.action(
  'dl_single_file',
  async (ctx) => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    if (
      !session.rootNode ||
      isDirectory(session.rootNode)
    ) {
      return ctx.reply(
        '❌ No downloadable file is ready.'
      );
    }

    await executeBatchDownload(
      ctx,
      [session.rootNode]
    );
  }
);

// ============================================================
// CALLBACK: DOWNLOAD SELECTED
// ============================================================

bot.action(
  'action_dl_selected',
  async (ctx) => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    if (
      !session.rootNode &&
      !session.currentFolder
    ) {
      return ctx.reply(
        '❌ No active MEGA session.'
      );
    }

    const allFiles =
      await collectAllFiles(
        session.rootNode ||
        session.currentFolder
      );

    const selectedFiles =
      allFiles.filter(file =>
        session.selectedIds.has(
          getNodeId(file)
        )
      );

    if (selectedFiles.length === 0) {
      return ctx.reply(
        '⚠️ No selected files were found.'
      );
    }

    await executeBatchDownload(
      ctx,
      selectedFiles
    );
  }
);

// ============================================================
// CALLBACK: DOWNLOAD CURRENT FOLDER
// ============================================================

bot.action(
  'action_dl_folder',
  async (ctx) => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    if (!session.currentFolder) {
      return ctx.reply(
        '❌ No active folder.'
      );
    }

    const status =
      await ctx.reply(
        '📦 Scanning this folder recursively...'
      );

    try {
      const files =
        await collectAllFiles(
          session.currentFolder
        );

      if (files.length === 0) {
        await ctx.telegram.editMessageText(
          status.chat.id,
          status.message_id,
          undefined,
          '⚠️ No downloadable files were found in this folder.'
        );

        return;
      }

      await executeBatchDownload(
        ctx,
        files,
        status.message_id
      );
    } catch (err) {
      console.error(
        '[FOLDER SCAN ERROR]',
        err
      );

      await ctx.telegram.editMessageText(
        status.chat.id,
        status.message_id,
        undefined,
        `❌ Failed to scan folder:\n${err.message}`
      );
    }
  }
);

// ============================================================
// CALLBACK: DOWNLOAD EVERYTHING
// ============================================================

bot.action(
  'action_dl_all',
  async (ctx) => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    const root =
      session.rootNode ||
      session.currentFolder;

    if (!root) {
      return ctx.reply(
        '❌ No active MEGA session.'
      );
    }

    if (!isDirectory(root)) {
      return executeBatchDownload(
        ctx,
        [root]
      );
    }

    const status =
      await ctx.reply(
        '📦 Scanning all folders recursively...'
      );

    try {
      const files =
        await collectAllFiles(root);

      if (files.length === 0) {
        await ctx.telegram.editMessageText(
          status.chat.id,
          status.message_id,
          undefined,
          '⚠️ No downloadable files were found.'
        );

        return;
      }

      await executeBatchDownload(
        ctx,
        files,
        status.message_id
      );
    } catch (err) {
      console.error(
        '[ALL FILE SCAN ERROR]',
        err
      );

      await ctx.telegram.editMessageText(
        status.chat.id,
        status.message_id,
        undefined,
        `❌ Failed to scan MEGA files:\n${err.message}`
      );
    }
  }
);

// ============================================================
// DOWNLOAD JOB
// ============================================================

async function executeBatchDownload(
  ctx,
  fileNodes,
  existingMsgId = null
) {
  const session =
    getSession(ctx.from.id);

  if (
    session.activeJob
  ) {
    return ctx.reply(
      '⚠️ A download is already running.\n\nUse /cancel to stop it.'
    );
  }

  const uniqueFiles = [];

  const seenIds = new Set();

  for (const file of fileNodes) {
    if (!file || isDirectory(file)) {
      continue;
    }

    const id =
      getNodeId(file);

    if (id && seenIds.has(id)) {
      continue;
    }

    if (id) {
      seenIds.add(id);
    }

    uniqueFiles.push(file);
  }

  if (uniqueFiles.length === 0) {
    return ctx.reply(
      '⚠️ No downloadable files were found.'
    );
  }

  let statusMsg;

  if (existingMsgId) {
    statusMsg = {
      chat: {
        id: ctx.chat.id
      },
      message_id: existingMsgId
    };
  } else if (
    ctx.callbackQuery &&
    ctx.callbackQuery.message
  ) {
    statusMsg =
      ctx.callbackQuery.message;
  } else {
    statusMsg =
      await ctx.reply(
        '🚀 Starting download...'
      );
  }

  // ----------------------------------------------------------
  // IMPORTANT:
  // Keep this exact object alive for the whole job.
  // /cancel changes job.cancelled instead of destroying
  // the reference.
  // ----------------------------------------------------------

  const job = {
    cancelled: false,
    stream: null,
    writeStream: null,
    tempFilePath: null,
    messageId: statusMsg.message_id
  };

  session.activeJob = job;

  const totalFiles =
    uniqueFiles.length;

  let successfulCount = 0;

  const failedFiles = [];

  console.log(
    `[DOWNLOAD] Starting ${totalFiles} file(s) for ${ctx.from.id}`
  );

  try {
    for (
      let index = 0;
      index < totalFiles;
      index++
    ) {
      if (job.cancelled) {
        console.log(
          `[DOWNLOAD] Job cancelled before file ${index + 1}`
        );

        break;
      }

      const node =
        uniqueFiles[index];

      const filename =
        sanitizeFilename(
          getNodeName(node)
        );

      const sizeStr =
        formatBytes(node.size);

      await updateProgressMessage(
        ctx,
        job.messageId,
        [
          `⬇️ Downloading (${index + 1}/${totalFiles})`,
          '',
          `📄 ${filename}`,
          `📦 Size: ${sizeStr}`,
          'Progress: 0%'
        ].join('\n')
      );

      const tempFilePath =
        makeTempFilePath(filename);

      job.tempFilePath =
        tempFilePath;

      try {
        // ====================================================
        // DOWNLOAD FROM MEGA
        // ====================================================

        await downloadMegaFileToDisk(
          node,
          tempFilePath,
          ctx,
          job,
          index,
          totalFiles,
          filename,
          sizeStr
        );

        if (job.cancelled) {
          throw new Error(
            'USER_CANCELLED'
          );
        }

        // ====================================================
        // UPLOAD TO TELEGRAM
        // ====================================================

        await updateProgressMessage(
          ctx,
          job.messageId,
          [
            `📤 Uploading (${index + 1}/${totalFiles})`,
            '',
            `📄 ${filename}`,
            `📦 Size: ${sizeStr}`
          ].join('\n')
        );

        await uploadFileToTelegram(
          ctx,
          tempFilePath,
          filename
        );

        successfulCount++;
      } catch (err) {
        if (
          job.cancelled ||
          err.message === 'USER_CANCELLED'
        ) {
          console.log(
            `[DOWNLOAD] Cancelled: ${filename}`
          );

          break;
        }

        console.error(
          `[DOWNLOAD ERROR] ${filename}`,
          err
        );

        failedFiles.push(
          `${filename} (${err.message || 'Unknown error'})`
        );
      } finally {
        cleanupTempFile(
          tempFilePath
        );

        job.tempFilePath = null;
        job.stream = null;
        job.writeStream = null;
      }
    }
  } finally {
    const wasCancelled =
      job.cancelled;

    // Only clear if this is still the same job.
    if (
      session.activeJob === job
    ) {
      session.activeJob = null;
    }

    if (wasCancelled) {
      await updateProgressMessage(
        ctx,
        job.messageId,
        '❌ Download task cancelled.'
      );

      return;
    }

    const processed =
      successfulCount +
      failedFiles.length;

    let finalReport;

    if (failedFiles.length === 0) {
      finalReport = [
        '✅ Download complete',
        '',
        `📦 Files: ${successfulCount}/${totalFiles}`,
        '🎉 All files were processed successfully.'
      ].join('\n');
    } else {
      finalReport = [
        '⚠️ Download completed with errors',
        '',
        `📦 Total: ${totalFiles}`,
        `✅ Successful: ${successfulCount}`,
        `❌ Failed: ${failedFiles.length}`,
        `📊 Processed: ${processed}`,
        ''
      ].join('\n');

      if (failedFiles.length > 0) {
        finalReport +=
          failedFiles
            .slice(0, 5)
            .map(
              item => `• ${item}`
            )
            .join('\n');

        if (failedFiles.length > 5) {
          finalReport +=
            `\n• ...and ${failedFiles.length - 5} more`;
        }
      }
    }

    await updateProgressMessage(
      ctx,
      job.messageId,
      finalReport
    );
  }
}

// ============================================================
// MEGA DOWNLOAD TO TEMP FILE
// ============================================================

function downloadMegaFileToDisk(
  node,
  tempFilePath,
  ctx,
  job,
  index,
  totalFiles,
  filename,
  sizeStr
) {
  return new Promise(
    (resolve, reject) => {
      let finished = false;

      let downloadedBytes = 0;

      let lastProgressTime = 0;

      let downloadStream;

      let writeStream;

      const finishOnce = (
        error = null
      ) => {
        if (finished) {
          return;
        }

        finished = true;

        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      try {
        downloadStream =
          node.download();

        writeStream =
          fs.createWriteStream(
            tempFilePath
          );

        job.stream =
          downloadStream;

        job.writeStream =
          writeStream;

        downloadStream.on(
          'data',
          chunk => {
            if (job.cancelled) {
              try {
                downloadStream.destroy(
                  new Error(
                    'USER_CANCELLED'
                  )
                );
              } catch (_) {}

              try {
                writeStream.destroy(
                  new Error(
                    'USER_CANCELLED'
                  )
                );
              } catch (_) {}

              return;
            }

            downloadedBytes +=
              chunk.length;

            const now =
              Date.now();

            if (
              now - lastProgressTime >=
                DOWNLOAD_PROGRESS_INTERVAL_MS &&
              node.size > 0
            ) {
              lastProgressTime =
                now;

              const percent =
                Math.min(
                  100,
                  Math.floor(
                    (downloadedBytes /
                      node.size) *
                      100
                  )
                );

              updateProgressMessage(
                ctx,
                job.messageId,
                [
                  `⬇️ Downloading (${index + 1}/${totalFiles})`,
                  '',
                  `📄 ${filename}`,
                  `📦 Size: ${sizeStr}`,
                  `Progress: ${percent}%`
                ].join('\n')
              ).catch(() => {});
            }
          }
        );

        downloadStream.on(
          'progress',
          info => {
            if (
              job.cancelled ||
              !info ||
              !info.bytesTotal
            ) {
              return;
            }

            const now =
              Date.now();

            if (
              now - lastProgressTime <
              DOWNLOAD_PROGRESS_INTERVAL_MS
            ) {
              return;
            }

            lastProgressTime =
              now;

            const percent =
              Math.min(
                100,
                Math.floor(
                  (info.bytesLoaded /
                    info.bytesTotal) *
                    100
                )
              );

            updateProgressMessage(
              ctx,
              job.messageId,
              [
                `⬇️ Downloading (${index + 1}/${totalFiles})`,
                '',
                `📄 ${filename}`,
                `📦 Size: ${sizeStr}`,
                `Progress: ${percent}%`
              ].join('\n')
            ).catch(() => {});
          }
        );

        downloadStream.on(
          'error',
          err => {
            if (
              job.cancelled ||
              err.message === 'USER_CANCELLED'
            ) {
              finishOnce(
                new Error(
                  'USER_CANCELLED'
                )
              );

              return;
            }

            finishOnce(err);
          }
        );

        writeStream.on(
          'error',
          err => {
            if (
              job.cancelled
            ) {
              finishOnce(
                new Error(
                  'USER_CANCELLED'
                )
              );

              return;
            }

            finishOnce(err);
          }
        );

        writeStream.on(
          'finish',
          () => {
            if (job.cancelled) {
              finishOnce(
                new Error(
                  'USER_CANCELLED'
                )
              );

              return;
            }

            finishOnce();
          }
        );

        downloadStream.pipe(
          writeStream
        );
      } catch (err) {
        finishOnce(err);
      }
    }
  );
}

// ============================================================
// TELEGRAM UPLOAD
// ============================================================

async function uploadFileToTelegram(
  ctx,
  filePath,
  filename
) {
  const mimeType =
    mime.lookup(filename) ||
    'application/octet-stream';

  const input = {
    source: filePath,
    filename
  };

  try {
    if (
      mimeType.startsWith('video/')
    ) {
      await ctx.replyWithVideo(
        input,
        {
          caption: filename
        }
      );

      return;
    }

    if (
      mimeType.startsWith('image/')
    ) {
      await ctx.replyWithPhoto(
        input,
        {
          caption: filename
        }
      );

      return;
    }

    if (
      mimeType.startsWith('audio/')
    ) {
      await ctx.replyWithAudio(
        input,
        {
          caption: filename
        }
      );

      return;
    }

    await ctx.replyWithDocument(
      input,
      {
        caption: filename
      }
    );
  } catch (mediaError) {
    console.warn(
      `[UPLOAD FALLBACK] ${filename}: ${mediaError.message}`
    );

    try {
      await ctx.replyWithDocument(
        input,
        {
          caption: filename
        }
      );
    } catch (documentError) {
      const description =
        documentError.description ||
        documentError.message ||
        '';

      if (
        description
          .toLowerCase()
          .includes('file is too large')
      ) {
        throw new Error(
          'Telegram rejected the file because it is too large for the bot upload limit.'
        );
      }

      throw documentError;
    }
  }
}

// ============================================================
// PROGRESS MESSAGE
// ============================================================

async function updateProgressMessage(
  ctx,
  messageId,
  text
) {
  const session =
    getSession(ctx.from.id);

  const now =
    Date.now();

  if (
    now - session.lastMsgEditTime <
    PROGRESS_EDIT_INTERVAL_MS
  ) {
    return;
  }

  session.lastMsgEditTime =
    now;

  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      messageId,
      undefined,
      text
    );
  } catch (err) {
    if (
      !err.description ||
      !err.description.includes(
        'message is not modified'
      )
    ) {
      console.error(
        '[PROGRESS UPDATE ERROR]',
        err.message
      );
    }
  }
}

// ============================================================
// ERROR HANDLING
// ============================================================

bot.catch(
  async (err, ctx) => {
    console.error(
      `[TELEGRAF ERROR] ${ctx.updateType}`,
      err
    );

    try {
      await ctx.reply(
        '❌ An unexpected error occurred while processing your request.'
      );
    } catch (_) {}
  }
);

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

function gracefulShutdown(
  signal
) {
  console.log(
    `[SHUTDOWN] Received ${signal}`
  );

  for (
    const session of userSessions.values()
  ) {
    try {
      session.cancelActiveJob();
    } catch (_) {}
  }

  try {
    bot.stop(signal);
  } catch (_) {}

  try {
    fs.removeSync(TEMP_DIR);
  } catch (_) {}

  process.exit(0);
}

process.once(
  'SIGINT',
  () => gracefulShutdown('SIGINT')
);

process.once(
  'SIGTERM',
  () => gracefulShutdown('SIGTERM')
);

// ============================================================
// START
// ============================================================

bot.launch()
  .then(() => {
    console.log(
      '🤖 Telegram MEGA Downloader Bot is running.'
    );
    console.log(
      `[TEMP] ${TEMP_DIR}`
    );
  })
  .catch(err => {
    console.error(
      '[BOT START ERROR]',
      err
    );

    process.exit(1);
  });
