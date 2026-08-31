import { localforage } from '../lib.js';
import { chat_metadata, eventSource, event_types, getRequestHeaders, getThumbnailUrl, saveSettingsDebounced } from '../script.js';
import { saveMetadataDebounced } from './extensions.js';
import { createThumbnail, flashHighlight, getBase64Async, sortIgnoreCaseAndAccents } from './utils.js';

const BG_METADATA_KEY = 'custom_background';
const LIST_METADATA_KEY = 'chat_backgrounds';

/** @type {Array<{id: string, name: string, thumbnailFile: string}>} */
let folderList = [];
/** @type {Object.<string, string[]>} filename → folderIds */
let imageFolderMap = {};
/** @type {string|null} Currently active folder drill-in, or null for root */
let activeFolderId = null;
/** @type {Set<string>} Selected system backgrounds for group folder actions */
const selectedSystemBackgroundFiles = new Set();
/** @type {boolean} Whether click-to-select mode is active for system backgrounds */
let isBackgroundSelectionMode = false;

// A single transparent PNG pixel used as a placeholder for errored backgrounds
const PNG_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_PIXEL_BLOB = new Blob([Uint8Array.from(atob(PNG_PIXEL), c => c.charCodeAt(0))], { type: 'image/png' });
const PLACEHOLDER_IMAGE = `url('data:image/png;base64,${PNG_PIXEL}')`;

const THUMBNAIL_COLUMNS_DEFAULT_DESKTOP = 5;
const THUMBNAIL_COLUMNS_DEFAULT_MOBILE = 3;

/**
 * Storage for frontend-generated background thumbnails.
 * This is used to store thumbnails for backgrounds that cannot be generated on the server.
 */
const THUMBNAIL_STORAGE = localforage.createInstance({ name: 'SillyTavern_Thumbnails' });

/**
 * Cache for thumbnail blob URLs.
 * @type {Map<string, string>}
 */
const THUMBNAIL_BLOBS = new Map();

const THUMBNAIL_CONFIG = {
    width: 160,
    height: 90,
};

const ANIMATED_BACKGROUND_EXTENSIONS = ['mp4', 'webp', 'gif', 'apng'];

/**
 * Cache for image metadata.
 * @type {Map<string, import('../../src/endpoints/image-metadata.js').ImageMetadata>}
 */
const METADATA_CACHE = new Map();

/**
 * Background source types.
 * @readonly
 * @enum {number}
 */
const BG_SOURCES = {
    GLOBAL: 0,
    CHAT: 1,
};

/**
 * Background sorting options.
 * @readonly
 * @enum {string}
 */
const BG_SORT_OPTIONS = {
    AZ: 'az',
    ZA: 'za',
    NEWEST: 'newest',
    OLDEST: 'oldest',
};

/**
 * Global IntersectionObserver instance for lazy loading backgrounds
 * @type {IntersectionObserver|null}
 */
let lazyLoadObserver = null;

/**
 * Cache for the current list of system background filenames.
 * Used to re-sort backgrounds without refetching from the server.
 * @type {Array<{filename: string, isAnimated: boolean}>}
 */
let cachedSystemBackgrounds = [];

export let background_settings = {
    name: '__transparent.png',
    url: generateUrlParameter('__transparent.png', false),
    fitting: 'classic',
    animation: false,
    sortOrder: BG_SORT_OPTIONS.AZ,
};

/**
 * Sorts an array of background filenames based on the current sort order.
 * @param {string[]} backgrounds - Array of background filenames
 * @param {boolean} isCustom - Whether these are custom (chat) backgrounds
 * @returns {string[]} Sorted array of background filenames
 */
function sortBackgrounds(backgrounds, isCustom = false) {
    const sortOrder = background_settings.sortOrder || BG_SORT_OPTIONS.AZ;

    return [...backgrounds].sort((a, b) => {
        switch (sortOrder) {
            case BG_SORT_OPTIONS.AZ:
                return sortIgnoreCaseAndAccents(a, b);
            case BG_SORT_OPTIONS.ZA:
                return sortIgnoreCaseAndAccents(b, a);
            case BG_SORT_OPTIONS.NEWEST:
            case BG_SORT_OPTIONS.OLDEST: {
                const keyA = isCustom ? a : `backgrounds/${a}`;
                const keyB = isCustom ? b : `backgrounds/${b}`;
                const metaA = METADATA_CACHE.get(keyA);
                const metaB = METADATA_CACHE.get(keyB);
                const timestampA = metaA?.addedTimestamp ?? 0;
                const timestampB = metaB?.addedTimestamp ?? 0;
                // Newest first (descending) or oldest first (ascending)
                return sortOrder === BG_SORT_OPTIONS.NEWEST
                    ? timestampB - timestampA
                    : timestampA - timestampB;
            }
            default:
                return 0;
        }
    });
}

/**
 * Creates a single thumbnail DOM element. The CSS now handles all sizing.
 * @param {object} imageData - Data for the image (filename, isCustom, isAnimated).
 * @returns {HTMLElement} The created thumbnail element.
 */
function createThumbnailElement(imageData) {
    const bg = imageData.filename;
    const isCustom = imageData.isCustom;
    const isAnimated = imageData.isAnimated ?? false;

    const thumbnail = $('#background_template .bg_example').clone();

    const clipper = document.createElement('div');
    clipper.className = 'thumbnail-clipper lazy-load-background';
    clipper.style.backgroundImage = PLACEHOLDER_IMAGE;

    // Apply dominant color and aspect ratio as placeholder if available
    const metadataKey = isCustom ? bg : `backgrounds/${bg}`;
    const metadata = METADATA_CACHE.get(metadataKey);
    if (metadata) {
        if (metadata.dominantColor) {
            clipper.style.backgroundColor = metadata.dominantColor;
        }
        if (metadata.aspectRatio) {
            thumbnail.css('aspect-ratio', metadata.aspectRatio);
        }
    }

    const titleElement = thumbnail.find('.BGSampleTitle');
    clipper.appendChild(titleElement.get(0));
    thumbnail.append(clipper);

    const url = generateUrlParameter(bg, isCustom);
    const title = isCustom ? bg.split('/').pop() : bg;
    const friendlyTitle = String(title || '').slice(0, title.lastIndexOf('.'));

    thumbnail.attr('title', title);
    thumbnail.attr('bgfile', bg);
    thumbnail.attr('custom', String(isCustom));
    thumbnail.attr('animated', String(isAnimated));
    thumbnail.data('url', url);
    titleElement.text(friendlyTitle);

    return thumbnail.get(0);
}

export function loadBackgroundSettings(settings) {
    let backgroundSettings = settings.background;
    if (!backgroundSettings || !backgroundSettings.name || !backgroundSettings.url) {
        backgroundSettings = background_settings;
    }
    if (!backgroundSettings.fitting) {
        backgroundSettings.fitting = 'classic';
    }
    if (!Object.hasOwn(backgroundSettings, 'animation')) {
        backgroundSettings.animation = false;
    }
    if (!backgroundSettings.sortOrder) {
        backgroundSettings.sortOrder = BG_SORT_OPTIONS.AZ;
    }

    // If a value is already saved, use it. Otherwise, determine default based on screen size.
    let columns = backgroundSettings.thumbnailColumns;
    if (!columns) {
        const isNarrowScreen = window.matchMedia('(max-width: 480px)').matches;
        columns = isNarrowScreen ? THUMBNAIL_COLUMNS_DEFAULT_MOBILE : THUMBNAIL_COLUMNS_DEFAULT_DESKTOP;
    }
    background_settings.thumbnailColumns = columns;
    background_settings.sortOrder = backgroundSettings.sortOrder;
    background_settings.animation = backgroundSettings.animation;
    setBackground(backgroundSettings.name, backgroundSettings.url);
    setFittingClass(backgroundSettings.fitting);
}

/**
 * Sets the background for the current chat and adds it to the list of custom backgrounds.
 * @param {{url: string, path:string}} backgroundInfo
 */
async function forceSetBackground(backgroundInfo) {
    saveBackgroundMetadata(backgroundInfo.url);
    $('#bg1').css('background-image', backgroundInfo.url);

    const list = chat_metadata[LIST_METADATA_KEY] || [];
    const bg = backgroundInfo.path;
    list.push(bg);
    chat_metadata[LIST_METADATA_KEY] = list;
    saveMetadataDebounced();
    renderChatBackgrounds();
    highlightNewBackground(bg);
    highlightLockedBackground();
}

async function onChatChanged() {
    const lockedUrl = chat_metadata[BG_METADATA_KEY];

    $('#bg1').css('background-image', lockedUrl || background_settings.url);

    renderChatBackgrounds();
    highlightLockedBackground();
    highlightSelectedBackground();
}

/**
 * Checks if a given URL corresponds to a custom background in the current chat's metadata.
 * @param {string} fileUrl - The URL to check against the chat's custom backgrounds.
 * @returns {boolean} True if the URL corresponds to a custom background, false otherwise.
 */
export function isCustomBackgroundUrl(fileUrl) {
    const customBackgrounds = chat_metadata[LIST_METADATA_KEY] || [];
    return customBackgrounds.some(bg => bg === fileUrl || generateUrlParameter(bg, true) === fileUrl);
}

/**
 * Gets the client path for a background image, encoding the file name for safe URL usage.
 * @param {string} fileUrl File name or URL of the background image
 * @returns {string} Client path for the system backgroun
 */
export function getBackgroundPath(fileUrl) {
    return `backgrounds/${encodeURIComponent(fileUrl)}`;
}

function highlightLockedBackground() {
    $('.bg_example.locked-background').removeClass('locked-background');

    const lockedBackgroundUrl = chat_metadata[BG_METADATA_KEY];

    if (lockedBackgroundUrl) {
        $('.bg_example').filter(function () {
            return $(this).data('url') === lockedBackgroundUrl;
        }).addClass('locked-background');
    }
}

function isChatBackgroundLocked() {
    return chat_metadata[BG_METADATA_KEY];
}

function saveBackgroundMetadata(file) {
    chat_metadata[BG_METADATA_KEY] = file;
    saveMetadataDebounced();
}

/**
 * Gets a thumbnail for the background from storage or fetches it if not available.
 * It caches the thumbnail in local storage and returns a blob URL for the thumbnail.
 * If the thumbnail cannot be fetched, it returns a transparent PNG pixel as a fallback.
 * @param {string} bg Background URL
 * @param {boolean} isCustom Is the background custom?
 * @returns {Promise<string>} Blob URL of the thumbnail
 */
async function getThumbnailFromStorage(bg, isCustom) {
    const cachedBlobUrl = THUMBNAIL_BLOBS.get(bg);
    if (cachedBlobUrl) {
        return cachedBlobUrl;
    }

    const savedBlob = await THUMBNAIL_STORAGE.getItem(bg);
    if (savedBlob) {
        const savedBlobUrl = URL.createObjectURL(savedBlob);
        THUMBNAIL_BLOBS.set(bg, savedBlobUrl);
        return savedBlobUrl;
    }

    try {
        const url = isCustom ? bg : getBackgroundPath(bg);
        const response = await fetch(url, { cache: 'force-cache' });
        if (!response.ok) {
            throw new Error('Fetch failed with status: ' + response.status);
        }
        const imageBlob = await response.blob();
        const imageBase64 = await getBase64Async(imageBlob);
        const thumbnailBase64 = await createThumbnail(imageBase64, THUMBNAIL_CONFIG.width, THUMBNAIL_CONFIG.height);
        const thumbnailBlob = await fetch(thumbnailBase64).then(res => res.blob());
        await THUMBNAIL_STORAGE.setItem(bg, thumbnailBlob);
        const blobUrl = URL.createObjectURL(thumbnailBlob);
        THUMBNAIL_BLOBS.set(bg, blobUrl);
        return blobUrl;
    } catch (error) {
        console.error('Error fetching thumbnail, fallback image will be used:', error);
        const fallbackBlob = PNG_PIXEL_BLOB;
        const fallbackBlobUrl = URL.createObjectURL(fallbackBlob);
        THUMBNAIL_BLOBS.set(bg, fallbackBlobUrl);
        return fallbackBlobUrl;
    }
}

/**
 * Renders the system backgrounds gallery.
 * @param {Array<{filename: string, isAnimated: boolean}>} [backgrounds] - Optional filtered list of backgrounds with metadata.
 */
function renderSystemBackgrounds(backgrounds) {
    const sourceList = backgrounds || [];
    const container = $('#bg_menu_content');
    container.empty();

    if (sourceList.length === 0) {
        syncGroupSelectionUi();
        return;
    }

    const sortedList = sortBackgrounds(sourceList.map(bg => bg.filename), false);
    const metadataByFilename = new Map(sourceList.map(bg => [bg.filename, bg]));
    sortedList.forEach(filename => {
        const bg = metadataByFilename.get(filename);
        const imageData = { filename, isCustom: false, isAnimated: bg?.isAnimated ?? false };
        const thumbnail = createThumbnailElement(imageData);
        container.append(thumbnail);
    });

    syncGroupSelectionUi();
    activateLazyLoader();
}

/**
 * Renders the chat-specific (custom) backgrounds gallery.
 * @param {string[]} [backgrounds] - Optional filtered list of backgrounds.
 */
function renderChatBackgrounds(backgrounds) {
    const sourceList = backgrounds ?? (chat_metadata[LIST_METADATA_KEY] || []);
    const container = $('#bg_custom_content');
    container.empty();
    $('#bg_chat_hint').toggle(!sourceList.length);

    if (sourceList.length === 0) return;

    const sortedList = sortBackgrounds(sourceList, true);
    sortedList.forEach(bg => {
        // For custom backgrounds, infer isAnimated from extension since we don't have server metadata
        const isAnimated = isAnimatedBackgroundExtension(bg);
        const imageData = { filename: bg, isCustom: true, isAnimated };
        const thumbnail = createThumbnailElement(imageData);
        container.append(thumbnail);
    });

    activateLazyLoader();
}

export async function getBackgrounds() {
    const response = await fetch('/api/backgrounds/all', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });
    if (response.ok) {
        const { images, config } = await response.json();
        Object.assign(THUMBNAIL_CONFIG, config);
        cachedSystemBackgrounds = images;
        const existingFiles = new Set(images.map(x => x.filename));
        for (const selectedFile of selectedSystemBackgroundFiles) {
            if (!existingFiles.has(selectedFile)) {
                selectedSystemBackgroundFiles.delete(selectedFile);
            }
        }

        // Load folders first so getFilteredImages() works correctly in folder view
        await loadFolders();

        await preloadImageMetadata();

        // Render only filtered images if inside a folder, otherwise all
        renderSystemBackgrounds(getFilteredImages());
        highlightSelectedBackground();
    }
}

/**
 * Preloads all image metadata to use dominant colors as placeholders.
 * @return {Promise<void>}
 */
async function preloadImageMetadata() {
    try {
        const response = await fetch('/api/image-metadata/all', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ prefix: 'backgrounds/' }),
        });
        if (response.ok) {
            const data = await response.json();
            if (data?.images) {
                METADATA_CACHE.clear();
                for (const [path, metadata] of Object.entries(data.images)) {
                    METADATA_CACHE.set(path, metadata);
                }
            }
        }
    } catch (error) {
        console.error('[ImageMetadata] Failed to preload metadata:', error);
    }
}

/**
 * Loads folder data from the server (separate from image loading).
 */
async function loadFolders() {
    try {
        const response = await fetch('/api/backgrounds/folders', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });
        if (response.ok) {
            const data = await response.json();
            folderList = data.folders || [];
            imageFolderMap = data.imageFolderMap || {};

            // Auto-assign thumbnail for folders that don't have one, then persist
            const allImages = cachedSystemBackgrounds.map(img => img.filename);
            /** @type {{id: string, thumbnailFile: string}[]} */
            const thumbnailUpdates = [];
            for (const folder of folderList) {
                if (!folder.thumbnailFile) {
                    const firstImage = allImages.find(img => {
                        const fids = imageFolderMap[img];
                        return fids && fids.includes(folder.id);
                    });
                    if (firstImage) {
                        folder.thumbnailFile = firstImage;
                        thumbnailUpdates.push({ id: folder.id, thumbnailFile: firstImage });
                    }
                }
            }
            if (thumbnailUpdates.length > 0) {
                await fetch('/api/image-metadata/folders/set-thumbnails', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ updates: thumbnailUpdates }),
                }).catch(err => console.debug('Auto-thumbnail save failed:', err));
            }

            renderFolderGrid();
        }
    } catch (error) {
        console.error('Error loading folders:', error);
    }
}

/**
 * Renders the folder grid inside #bg_folder_grid.
 */
function renderFolderGrid() {
    const container = $('#bg_folder_grid');
    container.empty();

    if (folderList.length === 0 && !activeFolderId) {
        return;
    }

    for (const folder of folderList) {
        const tile = createFolderTileElement(folder);
        container.append(tile);
    }
}

/**
 * Creates a single folder tile DOM element.
 * @param {{id: string, name: string, thumbnailFile: string}} folder
 * @returns {HTMLElement}
 */
function createFolderTileElement(folder) {
    const tile = $('#bg_folder_tile_template .bg_folder_tile').clone();
    tile.attr('data-folder-id', folder.id);
    tile.find('.bg_folder_tile_name').text(folder.name);

    // Set cover image (async, update when resolved)
    getFolderCoverUrl(folder).then(coverUrl => {
        if (coverUrl) {
            tile.find('.bg_folder_tile_cover').css('background-image', `url("${coverUrl}")`);
        }
    });

    return tile.get(0);
}

/**
 * Gets the cover image URL for a folder.
 * Uses thumbnailFile if set, otherwise falls back to the first image in the folder.
 * @param {{id: string, name: string, thumbnailFile: string}} folder
 * @returns {Promise<string|null>}
 */
async function getFolderCoverUrl(folder) {
    const file = folder.thumbnailFile || cachedSystemBackgrounds.find(img => {
        const fids = imageFolderMap[img.filename];
        return fids && fids.includes(folder.id);
    })?.filename;
    if (!file) return null;

    if (isAnimatedBackgroundExtension(file) && !background_settings.animation) {
        return getThumbnailFromStorage(file, false);
    }
    return getThumbnailUrl('bg', file);
}

/**
 * Gets images filtered by the active folder.
 * @returns {Array<{filename: string, isAnimated: boolean}>}
 */
function getFilteredImages() {
    if (!activeFolderId) return cachedSystemBackgrounds;
    return cachedSystemBackgrounds.filter(img => {
        const fids = imageFolderMap[img.filename];
        return fids && fids.includes(activeFolderId);
    });
}

/**
 * Refreshes click-to-select and group action UI state.
 */
function syncGroupSelectionUi() {
    const selectedCount = selectedSystemBackgroundFiles.size;
    const isGlobalTab = getActiveBackgroundTab() === BG_SOURCES.GLOBAL;
    const showAddButton = isGlobalTab && isBackgroundSelectionMode && selectedCount > 0;
    const showRemoveFromCurrentFolderButton = isGlobalTab && Boolean(activeFolderId) && isBackgroundSelectionMode && selectedCount > 0;

    $('#Backgrounds').toggleClass('bg-selection-mode', isBackgroundSelectionMode);
    $('#bg_selection_mode_button').toggleClass('active', isBackgroundSelectionMode);
    $('#bg_group_select_count').text(selectedCount > 0 ? ` (${selectedCount})` : '').toggle(selectedCount > 0);

    $('#bg_group_add_to_folder_button').toggle(showAddButton);
    $('#bg_folder_remove_selected_button').toggle(showRemoveFromCurrentFolderButton);

    $('#bg_menu_content .bg_example').each(function () {
        const bgFile = String($(this).attr('bgfile') || '');
        $(this).toggleClass('folder-group-selected', selectedSystemBackgroundFiles.has(bgFile));
    });
}

function activateLazyLoader() {
    // Disconnect previous observer to prevent memory leaks
    if (lazyLoadObserver) {
        lazyLoadObserver.disconnect();
        lazyLoadObserver = null;
    }

    const lazyLoadElements = document.querySelectorAll('.lazy-load-background');

    const options = {
        root: null,
        rootMargin: '200px',
        threshold: 0.01,
    };

    lazyLoadObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.target instanceof HTMLElement && entry.isIntersecting) {
                const clipper = entry.target;
                const parentThumbnail = clipper.closest('.bg_example');

                if (parentThumbnail) {
                    const bg = parentThumbnail.getAttribute('bgfile');
                    const isCustom = parentThumbnail.getAttribute('custom') === 'true';
                    const isAnimated = parentThumbnail.getAttribute('animated') === 'true';
                    resolveImageUrl(bg, isCustom, isAnimated)
                        .then(url => { clipper.style.backgroundImage = url; })
                        .catch(() => { clipper.style.backgroundImage = PLACEHOLDER_IMAGE; });
                }

                clipper.classList.remove('lazy-load-background');
                observer.unobserve(clipper);
            }
        });
    }, options);

    lazyLoadElements.forEach(element => {
        lazyLoadObserver.observe(element);
    });
}

function generateUrlParameter(bg, isCustom) {
    return isCustom ? `url("${encodeURI(bg)}")` : `url("${getBackgroundPath(bg)}")`;
}

function isAnimatedBackgroundExtension(fileName) {
    const fileExtension = fileName.split('.').pop().toLowerCase();
    return ANIMATED_BACKGROUND_EXTENSIONS.includes(fileExtension);
}

/**
 * Resolves the image URL for the background.
 * @param {string} bg Background file name
 * @param {boolean} isCustom Is a custom background
 * @param {boolean|null} [isAnimated=null] Is the background animated (from metadata). If null, infers from extension.
 * @returns {Promise<string>} CSS URL of the background
 */
async function resolveImageUrl(bg, isCustom, isAnimated = null) {
    // If isAnimated is not provided (null), fall back to extension-based heuristic
    let animated = isAnimated;
    if (animated === null) {
        animated = isAnimatedBackgroundExtension(bg);
    }

    const thumbnailUrl = animated && !background_settings.animation
        ? await getThumbnailFromStorage(bg, isCustom)
        : isCustom
            ? bg
            : getThumbnailUrl('bg', bg);

    return `url("${thumbnailUrl}")`;
}

async function setBackground(bg, url) {
    // Only change the visual background if one is not locked for the current chat.
    if (!isChatBackgroundLocked()) {
        $('#bg1').css('background-image', url);
    }
    background_settings.name = bg;
    background_settings.url = url;
    saveSettingsDebounced();
}

/**
 * @param {string} bg
 */
function highlightNewBackground(bg) {
    const newBg = $(`.bg_example[bgfile="${bg}"]`);
    const scrollOffset = newBg.offset().top - newBg.parent().offset().top;
    $('#Backgrounds').scrollTop(scrollOffset);
    flashHighlight(newBg);
}

/**
 * Sets the fitting class for the background element
 * @param {string} fitting Fitting type
 */
function setFittingClass(fitting) {
    const backgrounds = $('#bg1');
    for (const option of ['cover', 'contain', 'stretch', 'center']) {
        backgrounds.toggleClass(option, option === fitting);
    }
    background_settings.fitting = fitting;
}

function highlightSelectedBackground() {
    $('.bg_example.selected-background').removeClass('selected-background');

    // The "selected" highlight should always reflect the global background setting.
    const activeUrl = background_settings.url;

    if (activeUrl) {
        // Find the thumbnail whose data-url attribute matches the active URL
        $('.bg_example').filter(function () {
            return $(this).data('url') === activeUrl;
        }).addClass('selected-background');
    }
}

/**
 * Gets the active background tab source.
 * @returns {BG_SOURCES} Active background tab source
 */
export function getActiveBackgroundTab() {
    const tabs = $('#bg_tabs');
    if (!tabs.length || !tabs.data('ui-tabs')) {
        return BG_SOURCES.GLOBAL;
    }
    return tabs.tabs('option', 'active');
}

export function initBackgrounds() {
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.FORCE_SET_BACKGROUND, forceSetBackground);
}
