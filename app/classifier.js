'use strict';

/*
 * Classificatore di categoria per le spese.
 * Naive Bayes multinomiale con:
 *  - feature dal testo della descrizione (token) + giorno della settimana + fascia di importo
 *  - pesatura temporale: le spese piu' recenti contano di piu' (half-life 6 mesi),
 *    cosi' il modello si adatta man mano che si registrano nuove spese nei mesi.
 * Nessuna dipendenza esterna: si ri-addestra in memoria dal database.
 */

const ALPHA = 0.5;              // smoothing di Laplace
const HALFLIFE_MONTHS = 6;      // dimezzamento del peso ogni 6 mesi
const WEIGHT_FLOOR = 0.2;       // peso minimo per le spese vecchie
const MIN_SAMPLES = 6;          // soglia minima per attivare il modello

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && t.length <= 24);
}

function amountBucket(amount) {
  const a = Number(amount) || 0;
  const edges = [5, 15, 30, 60, 120, 300];
  let i = 0;
  while (i < edges.length && a >= edges[i]) i++;
  return `amt:${i}`;
}

function features(row) {
  const f = tokenize(row.description);
  const d = new Date(`${row.spent_on}T00:00:00`);
  if (!Number.isNaN(d.getTime())) f.push(`dow:${d.getDay()}`);
  f.push(amountBucket(row.amount));
  return f;
}

function monthsAgo(iso, now) {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth()));
}

class Classifier {
  constructor() {
    this.trained = false;
    this.samples = 0;
    this.categories = [];
    this.accuracy = null;
    this._model = null;
  }

  train(rows) {
    const now = new Date();
    const labeled = rows
      .filter((r) => r.kind === 'expense' && r.category && String(r.category).trim())
      .map((r) => ({
        category: String(r.category).trim(),
        feats: features(r),
        w: Math.max(WEIGHT_FLOOR, Math.pow(0.5, monthsAgo(r.spent_on, now) / HALFLIFE_MONTHS)),
      }));

    this.samples = labeled.length;
    this._model = this._build(labeled);
    this.categories = Object.entries(this._model.classCount)
      .map(([name, w]) => ({ name, weight: +w.toFixed(2) }))
      .sort((a, b) => b.weight - a.weight);
    this.trained = this.samples >= MIN_SAMPLES && this.categories.length >= 2;
    this.accuracy = this.trained ? this._crossValAccuracy(labeled) : null;
    return this;
  }

  _build(labeled) {
    const classCount = Object.create(null);
    const classTokens = Object.create(null);
    const tokenCount = Object.create(null);
    const vocab = new Set();
    let total = 0;

    for (const { category: c, feats, w } of labeled) {
      classCount[c] = (classCount[c] || 0) + w;
      total += w;
      if (!tokenCount[c]) tokenCount[c] = Object.create(null);
      for (const t of feats) {
        vocab.add(t);
        tokenCount[c][t] = (tokenCount[c][t] || 0) + w;
        classTokens[c] = (classTokens[c] || 0) + w;
      }
    }
    return { classCount, classTokens, tokenCount, vocabSize: vocab.size || 1, total };
  }

  _rank(feats, model, exclude) {
    const m = model;
    const scores = [];

    for (const c of Object.keys(m.classCount)) {
      let cCount = m.classCount[c];
      let cTokens = m.classTokens[c] || 0;
      let total = m.total;
      const tc = m.tokenCount[c] || Object.create(null);
      let excl = null;

      if (exclude) {
        total -= exclude.w;
        if (exclude.category === c) {
          cCount -= exclude.w;
          excl = Object.create(null);
          for (const t of exclude.feats) {
            excl[t] = (excl[t] || 0) + exclude.w;
            cTokens -= exclude.w;
          }
        }
      }
      if (cCount <= 0 || total <= 0) continue;

      const denom = Math.max(cTokens + ALPHA * m.vocabSize, ALPHA);
      let logp = Math.log(cCount / total);
      for (const t of feats) {
        let num = (tc[t] || 0) + ALPHA;
        if (excl && excl[t]) num -= excl[t];
        logp += Math.log(Math.max(num, 1e-9) / denom);
      }
      scores.push([c, logp]);
    }
    if (!scores.length) return [];

    const max = Math.max(...scores.map((s) => s[1]));
    let sum = 0;
    const exps = scores.map(([c, lp]) => {
      const e = Math.exp(lp - max);
      sum += e;
      return [c, e];
    });
    return exps
      .map(([c, e]) => ({ category: c, p: e / sum }))
      .sort((a, b) => b.p - a.p);
  }

  predict(input) {
    if (!this.trained) return null;
    const ranked = this._rank(features(input), this._model);
    if (!ranked.length) return null;
    return {
      category: ranked[0].category,
      confidence: +ranked[0].p.toFixed(3),
      alternatives: ranked.slice(1, 4).map((r) => ({ category: r.category, p: +r.p.toFixed(3) })),
    };
  }

  // Accuratezza stimata in cross-validation "leave-one-out" (campionata se il dataset e' grande)
  _crossValAccuracy(labeled) {
    const testSet =
      labeled.length > 1200
        ? labeled.filter((_, i) => i % Math.ceil(labeled.length / 300) === 0)
        : labeled;

    let correct = 0;
    let n = 0;
    for (const ex of testSet) {
      const ranked = this._rank(ex.feats, this._model, ex);
      if (!ranked.length) continue;
      n++;
      if (ranked[0].category === ex.category) correct++;
    }
    return n ? +(correct / n).toFixed(3) : null;
  }
}

module.exports = { Classifier };
