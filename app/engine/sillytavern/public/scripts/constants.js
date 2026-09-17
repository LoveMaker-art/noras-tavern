// Keep runtime fallback/reset paths aligned with the packaged Default preset.
export const DEFAULT_STORY_PROMPT = `# 角色

你是沉浸式互动故事的叙事与角色扮演引擎，负责扮演当前情景中除 {{user}} 外的相关角色。

# 能力

综合当前角色与世界上下文（{{char}}）、角色资料、情景设定、已激活的世界书和历史对话，判断当前应当出场的角色，并保持各自的身份、性格、语气、动机、关系和信息边界。

# 任务

根据 {{user}} 最后的消息继续故事。只描写当前自然在场或与情景相关的角色，不要求所有角色发言。保持剧情连续，不替 {{user}} 决定行动、对白、想法或感受。

优先遵循角色卡、世界书和脚本规定的专属指令与输出格式；除此之外只返回本轮故事内容，并为 {{user}} 留下继续回应的空间。`;

/**
 * Common debounce timeout values to use with `debounce` calls.
 * @readonly
 * @enum {number}
 */
export const debounce_timeout = {
    /** [100 ms] For ultra-fast responses, typically for keypresses or executions that might happen multiple times in a loop or recursion. */
    quick: 100,
    /** [200 ms] Slightly slower than quick, but still very responsive. */
    short: 200,
    /** [300 ms] Default time for general use, good balance between responsiveness and performance. */
    standard: 300,
    /** [1.000 ms] For situations where the function triggers more intensive tasks. */
    relaxed: 1000,
    /** [5 sec] For delayed tasks, like auto-saving or completing batch operations that need a significant pause. */
    extended: 5000,
};

/**
 * Used as an ephemeral key in message extra metadata.
 * When set, the message will be excluded from generation
 * prompts without affecting the number of chat messages,
 * which is needed to preserve world info timed effects.
 */
export const IGNORE_SYMBOL = Symbol.for('ignore');

/**
 * Common video file extensions. Should be the same as supported by Gemini.
 * https://ai.google.dev/gemini-api/docs/video-understanding#supported-formats
 */
export const VIDEO_EXTENSIONS = ['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', '3gp', 'mkv', 'mpg'];

/**
 * Known generation triggers that can be passed to Generate function.
 */
export const GENERATION_TYPE_TRIGGERS = [
    'normal',
    'continue',
    'impersonate',
    'swipe',
    'regenerate',
    'quiet',
];

export const persona_description_positions = {
    IN_PROMPT: 0,
    /**
     * @deprecated Use persona_description_positions.IN_PROMPT instead.
     */
    AFTER_CHAR: 1,
    TOP_AN: 2,
    BOTTOM_AN: 3,
    AT_DEPTH: 4,
    NONE: 9,
};

/**
 * Known injection IDs and helper functions for system extensions handling.
 */
export const inject_ids = {
    STORY_STRING: '__STORY_STRING__',
    QUIET_PROMPT: 'QUIET_PROMPT',
    DEPTH_PROMPT: 'DEPTH_PROMPT',
    DEPTH_PROMPT_INDEX: (index) => `DEPTH_PROMPT_${index}`,
    CUSTOM_WI_DEPTH: 'customDepthWI',
    CUSTOM_WI_DEPTH_ROLE: (depth, role) => `customDepthWI_${depth}_${role}`,
    CUSTOM_WI_OUTLET: (key) => `customWIOutlet_${key}`,
};

export const COMETAPI_IGNORE_PATTERNS = [
    // Image generation models
    'dall-e', 'dalle', 'midjourney', 'mj_', 'stable-diffusion', 'sd-',
    'flux-', 'playground-v', 'ideogram', 'recraft-', 'black-forest-labs',
    '/recraft-v3', 'recraftv3', 'stability-ai/', 'sdxl',
    // Audio generation models
    'suno_', 'tts', 'whisper',
    // Video generation models
    'runway', 'luma_', 'luma-', 'veo', 'kling_', 'minimax_video', 'hunyuan-t1',
    // Utility models
    'embedding', 'search-gpts', 'files_retrieve', 'moderation',
];

/**
 * @readonly
 * @enum {string}
 */
export const MEDIA_SOURCE = {
    API: 'api',
    UPLOAD: 'upload',
    GENERATED: 'generated',
    CAPTIONED: 'captioned',
};

/**
 * @readonly
 * @enum {string}
 */
export const MEDIA_DISPLAY = {
    LIST: 'list',
    GALLERY: 'gallery',
};

/**
 * @readonly
 * @enum {string}
 */
export const IMAGE_OVERSWIPE = {
    GENERATE: 'generate',
    ROLLOVER: 'rollover',
};

/**
 * @readonly
 */
export const MEDIA_TYPE = {
    getFromMime: (/** @type {string} */ mimeType) => {
        if (mimeType.startsWith('image/')) {
            return MEDIA_TYPE.IMAGE;
        }
        if (mimeType.startsWith('video/')) {
            return MEDIA_TYPE.VIDEO;
        }
        if (mimeType.startsWith('audio/')) {
            return MEDIA_TYPE.AUDIO;
        }
        return null;
    },
    IMAGE: 'image',
    VIDEO: 'video',
    AUDIO: 'audio',
};

/**
 * Bitwise flag-style media request types.
 * @readonly
 * @enum {number}
 */
export const MEDIA_REQUEST_TYPE = {
    IMAGE: 0b001,
    VIDEO: 0b010,
    AUDIO: 0b100,
};

/**
 * Scroll behavior options when appending media to messages.
 * @readonly
 * @enum {string}
 */
export const SCROLL_BEHAVIOR = {
    NONE: 'none',
    KEEP: 'keep',
    ADJUST: 'adjust',
};

/**
 * @readonly
 * @enum {string}
 */
export const OVERSWIPE_BEHAVIOR = {
    /** The overswipe right chevron will not be displayed. */
    NONE: 'none',
    /** An overswipe will loop to the first swipe. */
    LOOP: 'loop',
    /** Pristine greetings will loop, and chevrons will always be shown: https://github.com/SillyTavern/SillyTavern/pull/4712#issuecomment-3557893373 */
    PRISTINE_GREETING: 'pristine_greeting',
    /** If chat tree is enabled, then an overswipe will allow the user to edit the message before starting a new generation. */
    EDIT_GENERATE: 'edit_generate',
    /** This is the default behavior on character messages. */
    REGENERATE: 'regenerate',
};

/**
 * @readonly
 * @enum {string}
 */
export const SWIPE_DIRECTION = {
    LEFT: 'left',
    RIGHT: 'right',
};

/**
 * @readonly
 * @enum {string}
 */
export const SWIPE_SOURCE = {
    DELETE: 'delete',
    KEYBOARD: 'keyboard',
    BACK: 'back',
    AUTO_SWIPE: 'auto_swipe',
    SLASH_COMMAND: 'slash_command',
    SWIPE_PICKER: 'swipe_picker',
};

/**
 * @readonly
 * @enum {string}
 */
export const SWIPE_STATE = {
    NONE: 'none',
    SWIPING: 'swiping',
    EDITING: 'editing',
};
