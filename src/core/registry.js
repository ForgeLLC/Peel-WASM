// Pass sırası: önce çalışma anı (şifreli veri), sonra yapısal geri dönüşümler (düzleştirme, opak koşullar), sabit
// katlama ve ölü kod (ölü fonksiyonlar parça sanılıp satır içine alınmasın diye bölme geri almadan önce), en son
// adlandırma; her tur bu sırayla döner.
import * as data from '../passes/data.js';
import * as cff from '../passes/cff.js';
import * as opaque from '../passes/opaque.js';
import * as inline from '../passes/inline.js';
import * as fold from '../passes/fold.js';
import * as dead from '../passes/dead.js';
import * as names from '../passes/names.js';

export const PASSES = [data, cff, opaque, fold, dead, inline, names];
