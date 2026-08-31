import lodash from 'lodash';
import Fuse from 'fuse.js';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import localforage from 'localforage';
import Handlebars from 'handlebars';
import css from '@adobe/css-tools';
import Bowser from 'bowser';
import DiffMatchPatch from 'diff-match-patch';
import { isProbablyReaderable, Readability } from '@mozilla/readability';
import SVGInject from '@iconfu/svg-inject';
import showdown from 'showdown';
import moment from 'moment';
import seedrandom from 'seedrandom';
import * as Popper from '@popperjs/core';
import droll from 'droll';
import morphdom from 'morphdom';
import * as chevrotain from 'chevrotain';
import { gzipSync, gzip } from 'fflate';
import { sha256 } from 'js-sha256';

export function initLibraryShims() {
    if (!window) return;
    if (!('Fuse' in window)) window.Fuse = Fuse;
    if (!('DOMPurify' in window)) window.DOMPurify = DOMPurify;
    if (!('hljs' in window)) window.hljs = hljs;
    if (!('localforage' in window)) window.localforage = localforage;
    if (!('Handlebars' in window)) window.Handlebars = Handlebars;
    if (!('diff_match_patch' in window)) window.diff_match_patch = DiffMatchPatch;
    if (!('SVGInject' in window)) window.SVGInject = SVGInject;
    if (!('showdown' in window)) window.showdown = showdown;
    if (!('moment' in window)) window.moment = moment;
    if (!('Popper' in window)) window.Popper = Popper;
    if (!('droll' in window)) window.droll = droll;
}

const libs = {
    lodash,
    Fuse,
    DOMPurify,
    hljs,
    localforage,
    Handlebars,
    css,
    Bowser,
    DiffMatchPatch,
    Readability,
    isProbablyReaderable,
    SVGInject,
    showdown,
    moment,
    seedrandom,
    Popper,
    droll,
    morphdom,
    chevrotain,
    gzipSync,
    gzip,
    sha256,
};

export default libs;

export {
    lodash,
    Fuse,
    DOMPurify,
    hljs,
    localforage,
    Handlebars,
    css,
    Bowser,
    DiffMatchPatch,
    Readability,
    isProbablyReaderable,
    SVGInject,
    showdown,
    moment,
    seedrandom,
    Popper,
    droll,
    morphdom,
    chevrotain,
    gzipSync,
    gzip,
    sha256,
};
