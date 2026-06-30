import * as flixhq from '../sources/flixhq.js';
import * as meowtv from '../sources/meowtv.js';
import * as cinezo from '../sources/cinezo.js';
import * as icefy from '../sources/icefy.js';
import * as vidrock from '../sources/vidrock.js';
import * as miruro from '../sources/miruro.js';
import * as vidzee from '../sources/vidzee.js';
import * as vidnest from '../sources/vidnest.js';
import * as fsharetv from '../sources/fsharetv.js';
import * as fsonic from '../sources/fsonic.js';
import * as toustream from '../sources/toustream.js';
import * as vapor from '../sources/vapor.js';
import * as moviebite from '../sources/moviebite.js';
import * as animehub from '../sources/animehub.js';
import * as kiroku from '../sources/kiroku.js';

export const WORKER_SOURCE_MODULES = {
    flixhq,
    meowtv,
    cinezo,
    icefy,
    vidrock,
    'miruro-sub': miruro,
    'miruro-dub': miruro,
    vidzee,
    vidnest,
    'vidnest-sub': vidnest,
    'vidnest-dub': vidnest,
    fsharetv,
    fsonic,
    toustream,
    vapor,
    moviebite,
    animehub,
    'kiroku-sub': kiroku,
    'kiroku-dub': kiroku,
};

export const WORKER_DISABLED_SOURCES = new Set([
    'vidlink',
]);
