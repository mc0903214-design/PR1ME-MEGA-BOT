const { Telegraf, Markup } = require('telegraf');
const { File: MegaFile } = require('megajs');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const mime = require('mime-types');

// ============================================================
// CONFIG
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN environment variable is required.');
}

const TEMP_DIR = path.join(
  os.tmpdir(),
  'telegram-mega-downloader'
);

const ITEMS_PER_PAGE = 8;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const PROGRESS_EDIT_INTERVAL_MS = 1500;
const DOWNLOAD_PROGRESS_INTERVAL_MS = 2500;

fs.ensureDirSync(TEMP_DIR);

// ============================================================
// BOT
// ============================================================

const bot = new Telegraf(BOT_TOKEN);

// ============================================================
// SESSION STORAGE
// ============================================================

const sessions = new Map();

class UserSession {
  constructor(userId) {
    this.userId = userId;

    // MEGA browser state
    this.rootNode = null;
    this.currentFolder = null;
    this.pathStack = [];

    // Selected file IDs
    this.selectedIds = new Set();

    // Pagination
    this.page = 0;

    // Active download job
    this.activeJob = null;

    // Activity
    this.lastActivity = Date.now();
    this.lastMsgEditTime = 0;

    // Used to invalidate old async link-loading operations
    this.generation = 0;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  invalidate() {
    this.generation++;
    return this.generation;
  }

  cancelActiveJob() {
    if (!this.activeJob) {
      return false;
    }

    this.activeJob.cancelled = true;

    try {
      if (this.activeJob.stream) {
        this.activeJob.stream.destroy();
      }
    } catch (err) {
      console.error('[CANCEL STREAM ERROR]', err);
    }

    try {
      if (this.activeJob.writeStream) {
        this.activeJob.writeStream.destroy();
      }
    } catch (err) {
      console.error('[CANCEL WRITE STREAM ERROR]', err);
    }

    return true;
  }

  resetBrowser() {
    this.rootNode = null;
    this.currentFolder = null;
    this.pathStack = [];
    this.selectedIds.clear();
    this.page = 0;
  }

  reset() {
    this.invalidate();
    this.cancelActiveJob();
    this.resetBrowser();
  }
}

function getSession(userId) {
  let session = sessions.get(userId);

  if (!session) {
    session = new UserSession(userId);
    sessions.set(userId, session);
  }

  session.touch();

  return session;
}

// ============================================================
// SESSION CLEANUP
// ============================================================

setInterval(() => {
  const now = Date.now();

  for (const [userId, session] of sessions.entries()) {
    if (
      !session.activeJob &&
      now - session.lastActivity > SESSION_TIMEOUT_MS
    ) {
      sessions.delete(userId);
    }
  }
}, 5 * 60 * 1000);

// ============================================================
// HELPERS
// ============================================================

function sanitizeFilename(name) {
  let safe = String(name || 'file');

  safe = safe
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  if (!safe) {
    safe = 'file';
  }

  // Avoid excessively long filesystem names.
  if (safe.length > 180) {
    safe = safe.slice(0, 180);
  }

  return safe;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'Unknown size';
  }

  if (bytes === 0) {
    return '0 B';
  }

  const units = [
    'B',
    'KB',
    'MB',
    'GB',
    'TB'
  ];

  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );

  const value = bytes / Math.pow(1024, index);

  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
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

function getNodeName(node) {
  if (!node) {
    return 'Unknown';
  }

  return (
    node.name ||
    node.attributes?.name ||
    node.label ||
    'Unnamed'
  );
}

function isDirectory(node) {
  if (!node) {
    return false;
  }

  if (node.directory === true) {
    return true;
  }

  if (node.type === 1) {
    return true;
  }

  if (node.type === 'folder') {
    return true;
  }

  if (Array.isArray(node.children)) {
    return true;
  }

  return false;
}

function getChildren(folder) {
  if (!folder || !isDirectory(folder)) {
    return [];
  }

  return Array.isArray(folder.children)
    ? folder.children
    : [];
}

function makeTempFilePath(filename) {
  const id = crypto.randomBytes(12).toString('hex');
  const safeName = sanitizeFilename(filename);

  return path.join(
    TEMP_DIR,
    `${Date.now()}-${id}-${safeName}`
  );
}

async function cleanupTempFile(filePath) {
  if (!filePath) {
    return;
  }

  try {
    await fs.remove(filePath);
  } catch (err) {
    console.error(
      '[TEMP CLEANUP ERROR]',
      filePath,
      err.message
    );
  }
}

function cleanErrorMessage(error) {
  if (!error) {
    return 'Unknown error.';
  }

  let message = error.message || String(error);

  message = message
    .replace(/\s+/g, ' ')
    .trim();

  if (message.length > 500) {
    message = message.slice(0, 500) + '...';
  }

  return message;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(text, maxLength = 55) {
  const value = String(text || '');

  if (value.length <= maxLength) {
    return value;
  }

  return value.slice(0, maxLength - 3) + '...';
}

// ============================================================
// MEGA URL PARSING
// ============================================================

function parseMegaUrl(url) {
  const value = String(url || '').trim();

  // Modern file:
  // https://mega.nz/file/ID#KEY
  const modernFile = value.match(
    /mega(?:\.nz|\.co\.nz)\/file\/([^#/?]+)#([^/?\s]+)/i
  );

  if (modernFile) {
    return {
      type: 'file',
      rootId: modernFile[1],
      key: modernFile[2],
      targetId: modernFile[1]
    };
  }

  // Modern folder:
  // https://mega.nz/folder/ROOT#KEY
  // https://mega.nz/folder/ROOT#KEY/folder/SUB
  // https://mega.nz/folder/ROOT#KEY/file/SUB
  const modernFolder = value.match(
    /mega(?:\.nz|\.co\.nz)\/folder\/([^#/?]+)#([^/?\s]+)(.*)?/i
  );

  if (modernFolder) {
    const rootId = modernFolder[1];
    const key = modernFolder[2];
    const remainder = modernFolder[3] || '';

    const targetFolder = remainder.match(
      /\/folder\/([^/?#]+)/i
    );

    const targetFile = remainder.match(
      /\/file\/([^/?#]+)/i
    );

    return {
      type: targetFile ? 'file' : 'folder',
      rootId,
      key,
      targetId:
        targetFile?.[1] ||
        targetFolder?.[1] ||
        rootId
    };
  }

  // Legacy file:
  // https://mega.nz/#!ID!KEY
  const legacyFile = value.match(
    /mega(?:\.nz|\.co\.nz)\/#!([^!/?]+)!([^/?\s]+)/i
  );

  if (legacyFile) {
    return {
      type: 'file',
      rootId: legacyFile[1],
      key: legacyFile[2],
      targetId: legacyFile[1]
    };
  }

  // Legacy folder:
  // https://mega.nz/#F!ID!KEY
  const legacyFolder = value.match(
    /mega(?:\.nz|\.co\.nz)\/#F!([^!/?]+)!([^/?\s]+)/i
  );

  if (legacyFolder) {
    return {
      type: 'folder',
      rootId: legacyFolder[1],
      key: legacyFolder[2],
      targetId: legacyFolder[1]
    };
  }

  return {
    type: 'unknown',
    rootId: null,
    key: null,
    targetId: null
  };
}

// ============================================================
// MEGA LOADING
// ============================================================

async function loadMegaNode(url) {
  const node = MegaFile.fromURL(url);

  await node.loadAttributes();

  return node;
}

async function loadMegaFolder(url) {
  const folder = MegaFile.fromURL(url);

  await folder.loadAttributes();

  if (!isDirectory(folder)) {
    throw new Error(
      'The supplied MEGA link is not a folder.'
    );
  }

  await ensureFolderLoaded(folder);

  return folder;
}

/**
 * Important:
 * Some MEGAJS node objects don't have their children populated
 * until their attributes are loaded.
 */
async function ensureFolderLoaded(folder) {
  if (!folder || !isDirectory(folder)) {
    throw new Error('The selected MEGA item is not a folder.');
  }

  if (!Array.isArray(folder.children)) {
    await folder.loadAttributes();
  }

  if (!Array.isArray(folder.children)) {
    throw new Error(
      'MEGA folder contents could not be loaded.'
    );
  }

  return folder;
}

// ============================================================
// ASYNC TREE SEARCH
// ============================================================

async function findNodeByIdAsync(folder, targetId) {
  if (!folder || !targetId) {
    return null;
  }

  await ensureFolderLoaded(folder);

  const children = getChildren(folder);

  for (const child of children) {
    const childId = getNodeId(child);

    if (childId === targetId) {
      return child;
    }
  }

  for (const child of children) {
    if (isDirectory(child)) {
      const found = await findNodeByIdAsync(
        child,
        targetId
      );

      if (found) {
        return found;
      }
    }
  }

  return null;
}

async function buildPathToNodeAsync(folder, targetId) {
  if (!folder || !targetId) {
    return null;
  }

  const folderId = getNodeId(folder);

  if (folderId === targetId) {
    return [];
  }

  await ensureFolderLoaded(folder);

  const children = getChildren(folder);

  for (const child of children) {
    if (getNodeId(child) === targetId) {
      return [child];
    }
  }

  for (const child of children) {
    if (!isDirectory(child)) {
      continue;
    }

    const result = await buildPathToNodeAsync(
      child,
      targetId
    );

    if (result) {
      return [child, ...result];
    }
  }

  return null;
}

// ============================================================
// RECURSIVE FILE COLLECTION
// ============================================================

async function collectAllFiles(node, output = []) {
  if (!node) {
    return output;
  }

  if (!isDirectory(node)) {
    output.push(node);
    return output;
  }

  await ensureFolderLoaded(node);

  const children = getChildren(node);

  for (const child of children) {
    await collectAllFiles(child, output);
  }

  return output;
}

// ============================================================
// TELEGRAM TEXT
// ============================================================

function getStartText() {
  return [
    '📥 MEGA DOWNLOADER',
    '',
    'Send me a public MEGA file or folder link.',
    '',
    'I can:',
    '• Browse folders',
    '• Open nested folders',
    '• Select individual files',
    '• Download multiple files',
    '• Download an entire folder',
    '• Download the complete MEGA folder',
    '',
    'Use /help for more information.'
  ].join('\n');
}

function getHelpText() {
  return [
    '📚 MEGA DOWNLOADER HELP',
    '',
    '1. Send a public MEGA link.',
    '2. If it is a folder, browse its contents.',
    '3. Select the files you want.',
    '4. Press Download Selected.',
    '',
    'Other options:',
    '• Download All',
    '• Download This Folder',
    '• Select All Here',
    '• Back',
    '• Root',
    '• Cancel',
    '',
    'Use /cancel at any time to stop an active download.'
  ].join('\n');
}

// ============================================================
// UI
// ============================================================

async function renderBrowserUI(ctx) {
  const session = getSession(ctx.from.id);

  const folder = session.currentFolder;

  if (!folder || !isDirectory(folder)) {
    return ctx.reply(
      '❌ Session expired. Please send the MEGA link again.'
    );
  }

  await ensureFolderLoaded(folder);

  const children = getChildren(folder);

  const folders = children.filter(isDirectory);
  const files = children.filter(
    item => !isDirectory(item)
  );

  const totalPages = Math.max(
    1,
    Math.ceil(
      files.length / ITEMS_PER_PAGE
    )
  );

  if (session.page >= totalPages) {
    session.page = totalPages - 1;
  }

  if (session.page < 0) {
    session.page = 0;
  }

  const start = session.page * ITEMS_PER_PAGE;

  const visibleFiles = files.slice(
    start,
    start + ITEMS_PER_PAGE
  );

  const buttons = [];

  // ----------------------------------------------------------
  // FOLDERS
  // ----------------------------------------------------------

  for (const item of folders) {
    /*
     * IMPORTANT FIX:
     *
     * Do NOT put getNodeId(item) into the callback and then
     * search the current folder by ID.
     *
     * MEGAJS can expose different ID properties depending on
     * the node/link structure.
     *
     * Instead, use the folder's index inside the current
     * folder's children array.
     */
    const folderIndex = children.indexOf(item);

    buttons.push([
      Markup.button.callback(
        `📂 ${truncate(getNodeName(item))}`,
        `nav_folder_index_${folderIndex}`
      )
    ]);
  }

  // ----------------------------------------------------------
  // FILES
  // ----------------------------------------------------------

  for (const item of visibleFiles) {
    const id = getNodeId(item);

    if (!id) {
      continue;
    }

    const selected = session.selectedIds.has(id);

    buttons.push([
      Markup.button.callback(
        `${selected ? '☑️' : '⬜'} ${truncate(getNodeName(item))}`,
        `toggle_file_${encodeURIComponent(id)}`
      )
    ]);
  }

  // ----------------------------------------------------------
  // ACTIONS
  // ----------------------------------------------------------

  if (files.length > 0) {
    buttons.push([
      Markup.button.callback(
        '✅ Select All Here',
        'action_select_all_here'
      )
    ]);
  }

  if (session.selectedIds.size > 0) {
    buttons.push([
      Markup.button.callback(
        `⬇️ Download Selected (${session.selectedIds.size})`,
        'action_dl_selected'
      )
    ]);
  }

  buttons.push([
    Markup.button.callback(
      '📥 Download This Folder',
      'action_dl_folder'
    )
  ]);

  buttons.push([
    Markup.button.callback(
      '📦 Download All',
      'action_dl_all'
    )
  ]);

  // ----------------------------------------------------------
  // PAGINATION
  // ----------------------------------------------------------

  if (totalPages > 1) {
    const pageButtons = [];

    if (session.page > 0) {
      pageButtons.push(
        Markup.button.callback(
          '⬅️ Previous',
          `page_${session.page - 1}`
        )
      );
    }

    pageButtons.push(
      Markup.button.callback(
        `${session.page + 1}/${totalPages}`,
        'noop'
      )
    );

    if (session.page < totalPages - 1) {
      pageButtons.push(
        Markup.button.callback(
          'Next ➡️',
          `page_${session.page + 1}`
        )
      );
    }

    buttons.push(pageButtons);
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
  }

  if (
    session.rootNode &&
    session.currentFolder !== session.rootNode
  ) {
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
  // MESSAGE
  // ----------------------------------------------------------

  const folderName = getNodeName(folder);

  let text = [
    `📂 ${escapeHtml(folderName)}`,
    '',
    `Folders: ${folders.length}`,
    `Files: ${files.length}`,
    `Selected: ${session.selectedIds.size}`,
    ''
  ].join('\n');

  if (files.length === 0 && folders.length === 0) {
    text += 'This folder is empty.';
  } else if (folders.length > 0 || files.length > 0) {
    text += 'Select a folder or choose files to download.';
  }

  try {
    await ctx.editMessageText(
      text,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(buttons)
      }
    );
  } catch (err) {
    /*
     * If the message cannot be edited because the user sent
     * the command from a normal chat message, send a new one.
     */
    if (
      !String(err.message || '')
        .toLowerCase()
        .includes('message is not modified')
    ) {
      try {
        await ctx.reply(
          text,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(buttons)
          }
        );
      } catch (replyError) {
        console.error(
          '[UI REPLY ERROR]',
          replyError
        );
      }
    }
  }
}

// ============================================================
// DIRECT FILE UI
// ============================================================

async function showDirectFile(ctx, file) {
  const name = getNodeName(file);
  const size = file.size;

  await ctx.reply(
    [
      '📄 FILE FOUND',
      '',
      `Name: ${name}`,
      `Size: ${formatBytes(size)}`,
      '',
      'Press the button below to download it.'
    ].join('\n'),
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '⬇️ Download File',
          'dl_single_file'
        )
      ],
      [
        Markup.button.callback(
          '❌ Cancel',
          'cancel_session'
        )
      ]
    ])
  );
}

// ============================================================
// PROGRESS MESSAGE
// ============================================================

async function updateProgressMessage(
  ctx,
  session,
  text,
  force = false
) {
  const now = Date.now();

  if (
    !force &&
    now - session.lastMsgEditTime <
      PROGRESS_EDIT_INTERVAL_MS
  ) {
    return;
  }

  session.lastMsgEditTime = now;

  try {
    await ctx.editMessageText(text);
  } catch (err) {
    const message = String(
      err.message || ''
    ).toLowerCase();

    if (
      !message.includes('message is not modified') &&
      !message.includes('message to edit not found')
    ) {
      console.error(
        '[PROGRESS EDIT ERROR]',
        err.message
      );
    }
  }
}

// ============================================================
// DOWNLOAD ONE MEGA FILE TO DISK
// ============================================================

async function downloadMegaFileToDisk(
  node,
  tempFilePath,
  job,
  onProgress
) {
  return new Promise(async (resolve, reject) => {
    let stream = null;
    let writeStream = null;

    let settled = false;
    let lastProgressTime = 0;

    const finishResolve = value => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    };

    const finishReject = error => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    try {
      if (job.cancelled) {
        return finishReject(
          new Error('Download cancelled.')
        );
      }

      stream = node.download();

      writeStream = fs.createWriteStream(
        tempFilePath
      );

      job.stream = stream;
      job.writeStream = writeStream;

      let downloaded = 0;
      let total = Number(node.size) || 0;

      stream.on('data', chunk => {
        if (job.cancelled) {
          try {
            stream.destroy();
          } catch (_) {}

          try {
            writeStream.destroy();
          } catch (_) {}

          return;
        }

        downloaded += chunk.length;

        const now = Date.now();

        if (
          now - lastProgressTime >=
          DOWNLOAD_PROGRESS_INTERVAL_MS
        ) {
          lastProgressTime = now;

          if (typeof onProgress === 'function') {
            onProgress(
              downloaded,
              total
            );
          }
        }
      });

      stream.on('progress', progress => {
        if (
          typeof progress === 'number' &&
          progress >= 0 &&
          progress <= 1
        ) {
          const downloadedFromProgress =
            total > 0
              ? Math.floor(total * progress)
              : 0;

          const now = Date.now();

          if (
            now - lastProgressTime >=
            DOWNLOAD_PROGRESS_INTERVAL_MS
          ) {
            lastProgressTime = now;

            if (typeof onProgress === 'function') {
              onProgress(
                downloadedFromProgress,
                total
              );
            }
          }
        }
      });

      stream.on('error', error => {
        try {
          writeStream.destroy();
        } catch (_) {}

        finishReject(error);
      });

      writeStream.on('error', error => {
        try {
          stream.destroy();
        } catch (_) {}

        finishReject(error);
      });

      writeStream.on('finish', () => {
        if (job.cancelled) {
          return finishReject(
            new Error('Download cancelled.')
          );
        }

        if (typeof onProgress === 'function') {
          onProgress(
            total || downloaded,
            total || downloaded
          );
        }

        finishResolve({
          downloadedBytes:
            total || downloaded
        });
      });

      stream.pipe(writeStream);

    } catch (error) {
      try {
        if (stream) {
          stream.destroy();
        }
      } catch (_) {}

      try {
        if (writeStream) {
          writeStream.destroy();
        }
      } catch (_) {}

      finishReject(error);
    }
  });
}

// ============================================================
// TELEGRAM UPLOAD
// ============================================================

async function uploadFileToTelegram(
  ctx,
  filePath,
  originalName
) {
  /*
   * Always upload as a DOCUMENT.
   *
   * This avoids Telegram treating images/videos/audio as
   * normal media and potentially changing how they are
   * processed/displayed.
   */
  await ctx.replyWithDocument({
    source: filePath,
    filename: sanitizeFilename(originalName)
  });
}

// ============================================================
// BATCH DOWNLOAD
// ============================================================

async function executeBatchDownload(
  ctx,
  session,
  files,
  title = 'Download'
) {
  if (session.activeJob) {
    await ctx.reply(
      '⚠️ A download is already running. Use /cancel to stop it.'
    );

    return;
  }

  const uniqueFiles = [];
  const seen = new Set();

  for (const file of files) {
    if (!file || isDirectory(file)) {
      continue;
    }

    const id = getNodeId(file);

    /*
     * Some MEGA objects may not expose the expected ID.
     * Use object reference as a fallback.
     */
    const key = id || file;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueFiles.push(file);
  }

  if (uniqueFiles.length === 0) {
    await ctx.reply(
      '❌ No files were found to download.'
    );

    return;
  }

  const job = {
    cancelled: false,
    stream: null,
    writeStream: null,
    tempFilePath: null,
    startedAt: Date.now()
  };

  session.activeJob = job;
  session.touch();

  let completed = 0;
  let failed = 0;
  let cancelled = false;

  try {
    await ctx.reply(
      [
        `🚀 ${title}`,
        '',
        `Files: ${uniqueFiles.length}`,
        '',
        'Starting download...'
      ].join('\n')
    );

    for (
      let index = 0;
      index < uniqueFiles.length;
      index++
    ) {
      if (job.cancelled) {
        cancelled = true;
        break;
      }

      const file = uniqueFiles[index];

      const fileName = getNodeName(file);
      const safeName = sanitizeFilename(fileName);

      const tempFilePath =
        makeTempFilePath(safeName);

      job.tempFilePath = tempFilePath;
      job.stream = null;
      job.writeStream = null;

      const fileNumber = index + 1;

      try {
        await ctx.reply(
          [
            `⬇️ Downloading ${fileNumber}/${uniqueFiles.length}`,
            '',
            `📄 ${truncate(fileName, 100)}`,
            `📦 Size: ${formatBytes(file.size)}`
          ].join('\n')
        );

        await downloadMegaFileToDisk(
          file,
          tempFilePath,
          job,
          (downloaded, total) => {
            const percentage =
              total > 0
                ? Math.floor(
                    (downloaded / total) * 100
                  )
                : null;

            let progressText = [
              `⬇️ Downloading ${fileNumber}/${uniqueFiles.length}`,
              '',
              `📄 ${truncate(fileName, 80)}`,
              '',
              `Downloaded: ${formatBytes(downloaded)}`
            ];

            if (total > 0) {
              progressText.push(
                `Total: ${formatBytes(total)}`,
                `Progress: ${percentage}%`
              );
            }

            updateProgressMessage(
              ctx,
              session,
              progressText.join('\n')
            ).catch(() => {});
          }
        );

        if (job.cancelled) {
          cancelled = true;
          break;
        }

        await ctx.reply(
          [
            `📤 Uploading ${fileNumber}/${uniqueFiles.length}`,
            '',
            `📄 ${truncate(fileName, 100)}`
          ].join('\n')
        );

        await uploadFileToTelegram(
          ctx,
          tempFilePath,
          fileName
        );

        completed++;

      } catch (error) {
        if (
          job.cancelled ||
          String(error.message || '')
            .toLowerCase()
            .includes('cancelled')
        ) {
          cancelled = true;
          break;
        }

        failed++;

        console.error(
          '[FILE DOWNLOAD ERROR]',
          fileName,
          error
        );

        await ctx.reply(
          [
            `❌ Failed: ${truncate(fileName, 100)}`,
            '',
            cleanErrorMessage(error)
          ].join('\n')
        );
      } finally {
        job.stream = null;
        job.writeStream = null;

        await cleanupTempFile(
          tempFilePath
        );

        job.tempFilePath = null;
      }
    }

    if (job.cancelled) {
      cancelled = true;
    }

    if (cancelled) {
      await ctx.reply(
        [
          '🛑 DOWNLOAD CANCELLED',
          '',
          `Completed: ${completed}`,
          `Failed: ${failed}`
        ].join('\n')
      );
    } else {
      await ctx.reply(
        [
          '✅ DOWNLOAD COMPLETE',
          '',
          `Completed: ${completed}`,
          `Failed: ${failed}`,
          `Total: ${uniqueFiles.length}`
        ].join('\n')
      );
    }

  } catch (error) {
    console.error(
      '[BATCH DOWNLOAD ERROR]',
      error
    );

    await ctx.reply(
      [
        '❌ Download process failed.',
        '',
        cleanErrorMessage(error)
      ].join('\n')
    );

  } finally {
    if (job.tempFilePath) {
      await cleanupTempFile(
        job.tempFilePath
      );
    }

    job.stream = null;
    job.writeStream = null;
    session.activeJob = null;
    session.touch();
  }
}

// ============================================================
// START
// ============================================================

bot.start(async ctx => {
  const session = getSession(ctx.from.id);

  session.reset();

  await ctx.reply(
    getStartText()
  );
});

// ============================================================
// HELP
// ============================================================

bot.command('help', async ctx => {
  await ctx.reply(
    getHelpText()
  );
});

// ============================================================
// CANCEL COMMAND
// ============================================================

bot.command('cancel', async ctx => {
  const session = getSession(ctx.from.id);

  if (session.activeJob) {
    session.cancelActiveJob();

    await ctx.reply(
      '🛑 Cancellation requested. The current download will stop.'
    );

    return;
  }

  session.reset();

  await ctx.reply(
    '❌ Current MEGA session cancelled.'
  );
});

// ============================================================
// TEXT HANDLER — MEGA LINKS
// ============================================================

bot.on('text', async ctx => {
  const text = String(
    ctx.message.text || ''
  ).trim();

  if (
    text.startsWith('/') ||
    !/mega(?:\.nz|\.co\.nz)/i.test(text)
  ) {
    return;
  }

  const session = getSession(ctx.from.id);

  if (session.activeJob) {
    await ctx.reply(
      '⚠️ A download is currently running. Use /cancel first.'
    );

    return;
  }

  const parsed = parseMegaUrl(text);

  if (parsed.type === 'unknown') {
    await ctx.reply(
      '❌ I could not recognize that MEGA link.'
    );

    return;
  }

  // Invalidate previous asynchronous link loading.
  const generation = session.invalidate();

  session.resetBrowser();

  await ctx.reply(
    '🔎 MEGA link received. Checking the contents...'
  );

  try {
    // --------------------------------------------------------
    // DIRECT FILE
    // --------------------------------------------------------

    if (parsed.type === 'file') {
      const file = await loadMegaNode(text);

      if (
        session.generation !== generation
      ) {
        return;
      }

      if (isDirectory(file)) {
        /*
         * Some links may technically parse as file links
         * while representing a folder. Treat it as a folder.
         */
        session.rootNode = file;
        session.currentFolder = file;
        session.pathStack = [];
        session.selectedIds.clear();
        session.page = 0;

        await renderBrowserUI(ctx);

        return;
      }

      session.rootNode = file;
      session.currentFolder = null;

      await showDirectFile(
        ctx,
        file
      );

      return;
    }

    // --------------------------------------------------------
    // FOLDER
    // --------------------------------------------------------

    const rootUrl =
      `https://mega.nz/folder/${parsed.rootId}#${parsed.key}`;

    const rootFolder =
      await loadMegaFolder(rootUrl);

    if (
      session.generation !== generation
    ) {
      return;
    }

    session.rootNode = rootFolder;
    session.currentFolder = rootFolder;
    session.pathStack = [];
    session.selectedIds.clear();
    session.page = 0;

    // If the URL points directly to a nested folder/file,
    // locate it asynchronously through the MEGA tree.
    if (
      parsed.targetId &&
      parsed.targetId !== parsed.rootId
    ) {
      const target =
        await findNodeByIdAsync(
          rootFolder,
          parsed.targetId
        );

      if (!target) {
        throw new Error(
          'The requested folder or file could not be found inside this MEGA share.'
        );
      }

      if (isDirectory(target)) {
        const pathToTarget =
          await buildPathToNodeAsync(
            rootFolder,
            parsed.targetId
          );

        if (Array.isArray(pathToTarget)) {
          session.pathStack = [];

          let previous =
            rootFolder;

          for (const folder of pathToTarget) {
            if (!folder) {
              continue;
            }

            session.pathStack.push({
              id: getNodeId(previous),
              name: getNodeName(previous),
              node: previous
            });

            previous = folder;
          }
        }

        session.currentFolder = target;
        session.page = 0;

        await ensureFolderLoaded(
          target
        );

        await renderBrowserUI(ctx);

        return;
      }

      // Direct file inside a folder share.
      session.currentFolder = null;
      session.rootNode = target;

      await showDirectFile(
        ctx,
        target
      );

      return;
    }

    await renderBrowserUI(ctx);

  } catch (error) {
    console.error(
      '[MEGA LINK ERROR]',
      error
    );

    if (
      session.generation !== generation
    ) {
      return;
    }

    await ctx.reply(
      [
        '❌ Could not load the MEGA link.',
        '',
        cleanErrorMessage(error),
        '',
        'Please make sure the link is public and still available.'
      ].join('\n')
    );
  }
});

// ============================================================
// NO-OP CALLBACK
// ============================================================

bot.action('noop', async ctx => {
  await ctx.answerCbQuery();
});

// ============================================================
// CANCEL BUTTON
// ============================================================

bot.action(
  'cancel_session',
  async ctx => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    if (session.activeJob) {
      session.cancelActiveJob();

      await ctx.reply(
        '🛑 Cancellation requested. The current download will stop.'
      );

      return;
    }

    session.reset();

    try {
      await ctx.editMessageText(
        '❌ MEGA session cancelled.'
      );
    } catch (_) {
      await ctx.reply(
        '❌ MEGA session cancelled.'
      );
    }
  }
);

// ============================================================
// PAGINATION
// ============================================================

bot.action(
  /^page_(\d+)$/,
  async ctx => {
    await ctx.answerCbQuery();

    const page =
      Number.parseInt(
        ctx.match[1],
        10
      );

    const session =
      getSession(ctx.from.id);

    if (session.activeJob) {
      await ctx.reply(
        '⚠️ A download is currently running. Use /cancel to stop it.'
      );

      return;
    }

    if (!Number.isInteger(page)) {
      return;
    }

    session.page = Math.max(
      0,
      page
    );

    try {
      await renderBrowserUI(ctx);
    } catch (error) {
      console.error(
        '[PAGE ERROR]',
        error
      );

      await ctx.reply(
        '❌ Could not change page.'
      );
    }
  }
);

// ============================================================
// OPEN FOLDER — FIXED VERSION
// ============================================================

bot.action(
  /^nav_folder_index_(\d+)$/,
  async ctx => {
    await ctx.answerCbQuery();

    const index =
      Number.parseInt(
        ctx.match[1],
        10
      );

    const session =
      getSession(ctx.from.id);

    if (session.activeJob) {
      await ctx.reply(
        '⚠️ A download is currently running. Use /cancel to stop it.'
      );

      return;
    }

    const current =
      session.currentFolder;

    if (
      !current ||
      !isDirectory(current)
    ) {
      await ctx.reply(
        '❌ Session expired. Please send the MEGA link again.'
      );

      return;
    }

    try {
      /*
       * Make sure the current folder's children are actually
       * loaded before using the index.
       */
      await ensureFolderLoaded(
        current
      );

      const children =
        getChildren(current);

      /*
       * THIS IS THE IMPORTANT FIX.
       *
       * The callback contains the array index instead of a
       * MEGA node ID. Therefore we retrieve the exact object
       * that generated the button.
       */
      const target =
        children[index];

      if (
        !target ||
        !isDirectory(target)
      ) {
        await ctx.reply(
          '❌ That folder could not be found. Please reopen the MEGA link.'
        );

        return;
      }

      /*
       * Load the selected folder's children before navigating
       * into it. This also fixes nested-folder browsing when
       * MEGAJS has not populated children yet.
       */
      await ensureFolderLoaded(
        target
      );

      session.pathStack.push({
        id: getNodeId(current),
        name: getNodeName(current),
        node: current
      });

      session.currentFolder = target;
      session.page = 0;

      await renderBrowserUI(ctx);

    } catch (error) {
      console.error(
        '[OPEN FOLDER ERROR]',
        error
      );

      await ctx.reply(
        [
          '❌ Could not open this folder.',
          '',
          cleanErrorMessage(error)
        ].join('\n')
      );
    }
  }
);

// ============================================================
// BACK
// ============================================================

bot.action(
  'nav_back',
  async ctx => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    if (session.activeJob) {
      await ctx.reply(
        '⚠️ A download is currently running. Use /cancel to stop it.'
      );

      return;
    }

    if (
      session.pathStack.length === 0
    ) {
      await renderBrowserUI(ctx);
      return;
    }

    const previous =
      session.pathStack.pop();

    if (
      !previous ||
      !previous.node
    ) {
      await ctx.reply(
        '❌ Navigation state was lost. Please reopen the MEGA link.'
      );

      return;
    }

    session.currentFolder =
      previous.node;

    session.page = 0;

    try {
      await ensureFolderLoaded(
        session.currentFolder
      );

      await renderBrowserUI(ctx);

    } catch (error) {
      console.error(
        '[BACK ERROR]',
        error
      );

      await ctx.reply(
        '❌ Could not go back to the previous folder.'
      );
    }
  }
);

// ============================================================
// ROOT
// ============================================================

bot.action(
  'nav_root',
  async ctx => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    if (session.activeJob) {
      await ctx.reply(
        '⚠️ A download is currently running. Use /cancel to stop it.'
      );

      return;
    }

    if (
      !session.rootNode ||
      !isDirectory(session.rootNode)
    ) {
      await ctx.reply(
        '❌ Root folder is no longer available. Please reopen the MEGA link.'
      );

      return;
    }

    session.currentFolder =
      session.rootNode;

    session.pathStack = [];
    session.page = 0;

    try {
      await ensureFolderLoaded(
        session.rootNode
      );

      await renderBrowserUI(ctx);

    } catch (error) {
      console.error(
        '[ROOT ERROR]',
        error
      );

      await ctx.reply(
        '❌ Could not return to the root folder.'
      );
    }
  }
);

// ============================================================
// TOGGLE FILE
// ============================================================

bot.action(
  /^toggle_file_(.+)$/,
  async ctx => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    if (session.activeJob) {
      await ctx.reply(
        '⚠️ A download is currently running. Use /cancel to stop it.'
      );

      return;
    }

    const id =
      decodeURIComponent(
        ctx.match[1]
      );

    if (
      session.selectedIds.has(id)
    ) {
      session.selectedIds.delete(id);
    } else {
      session.selectedIds.add(id);
    }

    try {
      await renderBrowserUI(ctx);
    } catch (error) {
      console.error(
        '[TOGGLE FILE ERROR]',
        error
      );

      await ctx.reply(
        '❌ Could not update file selection.'
      );
    }
  }
);

// ============================================================
// SELECT ALL HERE
// ============================================================

bot.action(
  'action_select_all_here',
  async ctx => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    if (session.activeJob) {
      await ctx.reply(
        '⚠️ A download is currently running. Use /cancel to stop it.'
      );

      return;
    }

    const folder =
      session.currentFolder;

    if (
      !folder ||
      !isDirectory(folder)
    ) {
      await ctx.reply(
        '❌ Folder session expired.'
      );

      return;
    }

    try {
      await ensureFolderLoaded(
        folder
      );

      const children =
        getChildren(folder);

      const files =
        children.filter(
          item => !isDirectory(item)
        );

      for (const file of files) {
        const id =
          getNodeId(file);

        if (id) {
          session.selectedIds.add(id);
        }
      }

      await renderBrowserUI(ctx);

    } catch (error) {
      console.error(
        '[SELECT ALL ERROR]',
        error
      );

      await ctx.reply(
        '❌ Could not select the files.'
      );
    }
  }
);

// ============================================================
// DOWNLOAD SINGLE FILE
// ============================================================

bot.action(
  'dl_single_file',
  async ctx => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    if (session.activeJob) {
      await ctx.reply(
        '⚠️ A download is already running.'
      );

      return;
    }

    const file =
      session.rootNode;

    if (
      !file ||
      isDirectory(file)
    ) {
      await ctx.reply(
        '❌ File session expired. Please send the MEGA link again.'
      );

      return;
    }

    await executeBatchDownload(
      ctx,
      session,
      [file],
      'Downloading File'
    );
  }
);

// ============================================================
// DOWNLOAD SELECTED
// ============================================================

bot.action(
  'action_dl_selected',
  async ctx => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    if (session.activeJob) {
      await ctx.reply(
        '⚠️ A download is already running.'
      );

      return;
    }

    if (
      !session.rootNode ||
      !isDirectory(session.rootNode)
    ) {
      await ctx.reply(
        '❌ Folder session expired. Please send the MEGA link again.'
      );

      return;
    }

    if (
      session.selectedIds.size === 0
    ) {
      await ctx.reply(
        '❌ No files selected.'
      );

      return;
    }

    try {
      const allFiles =
        await collectAllFiles(
          session.rootNode
        );

      const selectedFiles =
        allFiles.filter(file => {
          const id =
            getNodeId(file);

          return (
            id &&
            session.selectedIds.has(id)
          );
        });

      if (
        selectedFiles.length === 0
      ) {
        await ctx.reply(
          '❌ The selected files could not be found. Please select them again.'
        );

        return;
      }

      await executeBatchDownload(
        ctx,
        session,
        selectedFiles,
        'Downloading Selected Files'
      );

    } catch (error) {
      console.error(
        '[DOWNLOAD SELECTED ERROR]',
        error
      );

      await ctx.reply(
        [
          '❌ Could not prepare the selected files.',
          '',
          cleanErrorMessage(error)
        ].join('\n')
      );
    }
  }
);

// ============================================================
// DOWNLOAD THIS FOLDER
// ============================================================

bot.action(
  'action_dl_folder',
  async ctx => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    if (session.activeJob) {
      await ctx.reply(
        '⚠️ A download is already running.'
      );

      return;
    }

    const folder =
      session.currentFolder;

    if (
      !folder ||
      !isDirectory(folder)
    ) {
      await ctx.reply(
        '❌ Current folder is unavailable.'
      );

      return;
    }

    try {
      const files =
        await collectAllFiles(
          folder
        );

      if (files.length === 0) {
        await ctx.reply(
          '📂 This folder does not contain any files.'
        );

        return;
      }

      await executeBatchDownload(
        ctx,
        session,
        files,
        `Downloading ${getNodeName(folder)}`
      );

    } catch (error) {
      console.error(
        '[DOWNLOAD FOLDER ERROR]',
        error
      );

      await ctx.reply(
        [
          '❌ Could not prepare this folder.',
          '',
          cleanErrorMessage(error)
        ].join('\n')
      );
    }
  }
);

// ============================================================
// DOWNLOAD ALL
// ============================================================

bot.action(
  'action_dl_all',
  async ctx => {
    await ctx.answerCbQuery();

    const session =
      getSession(ctx.from.id);

    if (session.activeJob) {
      await ctx.reply(
        '⚠️ A download is already running.'
      );

      return;
    }

    const root =
      session.rootNode;

    if (
      !root ||
      !isDirectory(root)
    ) {
      await ctx.reply(
        '❌ Folder session expired. Please send the MEGA link again.'
      );

      return;
    }

    try {
      const files =
        await collectAllFiles(
          root
        );

      if (files.length === 0) {
        await ctx.reply(
          '📂 This MEGA folder does not contain any files.'
        );

        return;
      }

      await executeBatchDownload(
        ctx,
        session,
        files,
        'Downloading Entire MEGA Folder'
      );

    } catch (error) {
      console.error(
        '[DOWNLOAD ALL ERROR]',
        error
      );

      await ctx.reply(
        [
          '❌ Could not prepare the MEGA folder.',
          '',
          cleanErrorMessage(error)
        ].join('\n')
      );
    }
  }
);

// ============================================================
// GENERAL CALLBACK ERROR HANDLING
// ============================================================

bot.catch(async (error, ctx) => {
  console.error(
    '[TELEGRAF ERROR]',
    error
  );

  try {
    await ctx.reply(
      [
        '❌ Something went wrong.',
        '',
        cleanErrorMessage(error)
      ].join('\n')
    );
  } catch (replyError) {
    console.error(
      '[TELEGRAF ERROR REPLY FAILED]',
      replyError
    );
  }
});

// ============================================================
// STARTUP
// ============================================================

console.log(
  '🚀 MEGA Downloader Bot starting...'
);

console.log(
  `📁 Temporary directory: ${TEMP_DIR}`
);

bot.launch()
  .then(() => {
    console.log(
      '✅ MEGA Downloader Bot is running.'
    );
  })
  .catch(error => {
    console.error(
      '❌ Failed to start bot:',
      error
    );

    process.exit(1);
  });

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(signal) {
  console.log(
    `\n🛑 Received ${signal}. Shutting down...`
  );

  for (const session of sessions.values()) {
    if (session.activeJob) {
      session.cancelActiveJob();
    }
  }

  try {
    bot.stop(signal);
  } catch (error) {
    console.error(
      '[BOT STOP ERROR]',
      error
    );
  }

  try {
    await fs.remove(TEMP_DIR);
  } catch (error) {
    console.error(
      '[TEMP DIRECTORY CLEANUP ERROR]',
      error
    );
  }

  process.exit(0);
}

process.once(
  'SIGINT',
  () => shutdown('SIGINT')
);

process.once(
  'SIGTERM',
  () => shutdown('SIGTERM')
);
