/**
 * Keyword Generator
 * Automatically extracts product-related keywords from brand ads.
 *
 * Analyzes ad_creative_bodies, link_titles, and descriptions
 * to find the product terms that third-party advertisers would use.
 *
 * Example: MiaVola ads mention "Schilddrüse", "Hashimoto", "Schilddrüsen Test"
 * → These keywords are used to search for ALL advertisers in that niche
 */

import { MetaAd, KeywordGeneratorResult } from './types.ts';

// German stop words (common words to exclude)
const GERMAN_STOP_WORDS = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines', 'einem', 'einen',
  'und', 'oder', 'aber', 'doch', 'noch', 'auch', 'nur', 'schon', 'sehr', 'mehr', 'als',
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'sich', 'mich', 'dich', 'uns', 'euch',
  'mir', 'dir', 'ihm', 'ihr', 'mein', 'dein', 'sein', 'unser', 'euer', 'ihrer',
  'ist', 'sind', 'war', 'waren', 'wird', 'werden', 'hat', 'haben', 'hatte', 'hatten',
  'kann', 'können', 'soll', 'sollen', 'will', 'wollen', 'muss', 'müssen', 'darf', 'dürfen',
  'mit', 'von', 'aus', 'bei', 'nach', 'für', 'auf', 'über', 'unter', 'vor', 'hinter',
  'zwischen', 'neben', 'ohne', 'gegen', 'durch', 'bis', 'seit', 'während', 'wegen',
  'nicht', 'kein', 'keine', 'keinen', 'keinem', 'keiner', 'nichts', 'nie', 'niemals',
  'wenn', 'dann', 'weil', 'dass', 'damit', 'obwohl', 'während', 'bevor', 'nachdem',
  'wo', 'wie', 'was', 'wer', 'wann', 'warum', 'welche', 'welcher', 'welches',
  'hier', 'dort', 'da', 'jetzt', 'heute', 'morgen', 'gestern', 'immer', 'oft', 'mal',
  'so', 'denn', 'also', 'zum', 'zur', 'am', 'im', 'vom', 'beim', 'ins',
  'alle', 'alles', 'jede', 'jeder', 'jedes', 'jeden', 'jedem',
  'diese', 'dieser', 'dieses', 'diesen', 'diesem',
  'andere', 'anderer', 'anderes', 'anderen', 'anderem',
  'ganz', 'viel', 'viele', 'vielen', 'vieler', 'wenig', 'wenige',
  'neue', 'neuen', 'neuer', 'neues', 'neuem',
  'erste', 'ersten', 'erster', 'erstes', 'erstem',
  'gute', 'guten', 'guter', 'gutes', 'gutem', 'gut', 'besser', 'beste', 'besten',
  'große', 'großen', 'großer', 'großes', 'großem',
  'kleine', 'kleinen', 'kleiner', 'kleines', 'kleinem',
  'eigene', 'eigenen', 'eigener', 'eigenes',
  'deine', 'deinen', 'deiner', 'deines', 'deinem',
  'ihre', 'ihren', 'ihrem', 'ihres',
  'unsere', 'unseren', 'unserem', 'unseres',
  'einfach', 'schnell', 'direkt', 'sofort',
  // Common verbs and adjectives (not product-specific)
  'richtig', 'wissen', 'weiß', 'kennen', 'machen', 'macht', 'gehen', 'geht',
  'kommen', 'kommt', 'sagen', 'sagt', 'geben', 'gibt', 'nehmen', 'nimmt',
  'stehen', 'steht', 'lassen', 'lässt', 'finden', 'findet', 'bleiben', 'bleibt',
  'liegen', 'liegt', 'bringen', 'bringt', 'leben', 'lebt', 'fahren', 'fährt',
  'meinen', 'meint', 'fragen', 'fragt', 'kennt', 'stellt', 'zeigt', 'führt',
  'sprechen', 'spricht', 'halten', 'hält', 'spielen', 'spielt',
  'arbeiten', 'brauchen', 'braucht', 'folgen', 'lernen', 'bestehen',
  'verstehen', 'setzen', 'bekommen', 'beginnen', 'erzählen', 'versuchen',
  'schreiben', 'laufen', 'erklären', 'entsprechen', 'sitzen', 'ziehen',
  'scheinen', 'fallen', 'gehören', 'entstehen', 'erhalten', 'treffen',
  'suchen', 'legen', 'vorstellen', 'handeln', 'erreichen', 'tragen',
  'schaffen', 'lesen', 'verlieren', 'darstellen', 'erkennen', 'entwickeln',
  'reden', 'aussehen', 'erscheinen', 'bilden', 'anfangen', 'erwarten',
  // Common adjectives
  'lang', 'lange', 'langen', 'kurz', 'kurze', 'kurzen',
  'hoch', 'hohe', 'hohen', 'tief', 'tiefe', 'tiefen',
  'alt', 'alte', 'alten', 'jung', 'junge', 'jungen',
  'schwer', 'schwere', 'schweren', 'leicht', 'leichte', 'leichten',
  'stark', 'starke', 'starken', 'schwach', 'schwache', 'schwachen',
  'richtige', 'richtigen', 'gleich', 'gleichen', 'gleiche',
  'wirklich', 'endlich', 'natürlich', 'genau', 'bereits',
  'frustrierend', 'möglich', 'wichtig', 'nötig', 'fertig',
  // Time/date words
  'jahr', 'jahre', 'jahren', 'monat', 'monate', 'monaten',
  'woche', 'wochen', 'tag', 'stunde', 'stunden', 'minute', 'minuten',
  'anfang', 'ende', 'zeit', 'zeiten', 'start', 'startet',
  'neujahr', 'neujahrs', 'vorsatz', 'vorsätze',
  // Other common non-product words
  'weg', 'teil', 'seite', 'art', 'fall', 'grund', 'ziel',
  'sache', 'stelle', 'punkt', 'bild', 'wort', 'hand',
  'mensch', 'menschen', 'leute', 'frau', 'frauen', 'mann', 'männer',
  'kind', 'kinder', 'welt', 'land', 'stadt', 'haus',
  'problem', 'probleme', 'frage', 'antwort', 'lösung',
  'prozent', 'nummer', 'million', 'milliarden',
]);

// English stop words (comprehensive — includes common verbs, nouns, adjectives that appear across all niches)
const ENGLISH_STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'shall', 'must', 'need',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their',
  'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom',
  'here', 'there', 'where', 'when', 'why', 'how', 'all', 'each', 'every',
  'no', 'any', 'some', 'such', 'than', 'too', 'very', 'just', 'only',
  'own', 'same', 'also', 'other', 'new', 'now', 'get', 'got',
  // Common English words that appear across ALL niches (not product-specific)
  'like', 'know', 'think', 'want', 'make', 'take', 'come', 'look', 'give',
  'find', 'tell', 'said', 'says', 'call', 'keep', 'help', 'show', 'turn',
  'move', 'live', 'feel', 'seem', 'left', 'hand', 'high', 'last', 'long',
  'much', 'most', 'many', 'even', 'back', 'then', 'them', 'been', 'next',
  'well', 'still', 'down', 'over', 'such', 'only', 'time', 'year', 'made',
  'work', 'part', 'real', 'life', 'love', 'goes', 'went', 'seen', 'came',
  'used', 'going', 'first', 'world', 'right', 'place', 'thing', 'think',
  'never', 'being', 'always', 'those', 'after', 'again', 'about', 'under',
  'while', 'since', 'found', 'every', 'still', 'start', 'point', 'story',
  // Common English body parts / appearance words (too generic)
  'eyes', 'face', 'head', 'body', 'skin', 'hair', 'hand', 'hands', 'feet',
  'lips', 'neck', 'back', 'arms', 'legs', 'bone', 'bones', 'nail', 'nails',
  // Common English names that appear in ad copy (celebrity endorsements etc.)
  'demi', 'rhea', 'kate', 'emma', 'anna', 'lisa', 'sara', 'jane', 'rose',
  'mary', 'john', 'mark', 'paul', 'mike', 'alex', 'jade', 'lily', 'ruby',
  'maya', 'lena', 'nina', 'nora', 'mila', 'luna', 'ella', 'aria', 'isla',
  // Common English adjectives in ads
  'best', 'better', 'great', 'good', 'amazing', 'awesome', 'beautiful',
  'perfect', 'wonderful', 'incredible', 'fantastic', 'natural', 'pure',
  'true', 'real', 'full', 'open', 'sure', 'whole', 'clear', 'able',
  'free', 'deep', 'easy', 'hard', 'fast', 'slow', 'warm', 'cold', 'rich',
  'fresh', 'clean', 'safe', 'dark', 'fine', 'soft', 'wild', 'rare', 'calm',
  // Common English nouns in ads
  'way', 'day', 'man', 'woman', 'people', 'child', 'world', 'water',
  'food', 'home', 'house', 'money', 'power', 'level', 'night', 'light',
  'morning', 'dream', 'family', 'heart', 'mind', 'friend', 'health',
  'beauty', 'nature', 'magic', 'secret', 'gift', 'game', 'play', 'book',
  'page', 'story', 'word', 'name', 'number', 'group', 'side', 'room',
]);

// Generic ad words to exclude (these appear in ALL ads, not product-specific)
const GENERIC_AD_WORDS = new Set([
  // URLs/technical terms
  'http', 'https', 'www', 'com', '.de',

  // German generic ad phrases
  'jetzt', 'hier', 'klicken', 'angebot', 'aktion', 'rabatt', 'prozent',
  'gratis', 'kostenlos', 'versandkostenfrei', 'lieferung', 'versand',
  'bestellen', 'kaufen', 'shoppen', 'sichern', 'entdecken', 'erfahren',
  'verfügbar', 'limitiert', 'exklusiv', 'premium', 'original',
  'euro', 'preis', 'sparen', 'günstiger', 'reduziert', 'sale',
  'code', 'gutschein', 'link', 'bio', 'profil', 'seite', 'website',
  'facebook', 'instagram', 'shop', 'online', 'bestell', 'lieferbar',
  'erfahre', 'mehr', 'info', 'information', 'informationen',
  'deutschland', 'österreich', 'schweiz', 'berlin', 'münchen',
  'tage', 'wochen', 'monate', 'jahre', 'stunden', 'minuten',
  'über', 'unsere', 'unser', 'deine', 'dein', 'ihre',

  // German generic ad/CTA words (continued)
  'sicher', 'sichern', 'sichere', 'sicherer', 'sicheres',
  'entdecke', 'entdecken', 'entdeckt', 'erfahre', 'erfahr',
  'glücklich', 'glückliche', 'glücklichen', 'glücklicher',
  'kunden', 'kunde', 'kundin', 'kundinnen',
  'ergebnis', 'ergebnisse', 'ergebnissen',
  'bewertung', 'bewertungen', 'rezension', 'rezensionen',
  'qualität', 'garantie', 'zufrieden', 'zufriedenheit',
  'wirkung', 'wirkungen', 'effekt', 'effekte',
  'anwendung', 'einnahme', 'dosierung', 'empfehlung',
  'alternative', 'alternativen', 'variante', 'varianten',
  'hergestellt', 'produziert', 'entwickelt', 'getestet',
  'verpackung', 'lieferzeit', 'bestellung', 'paket',
  'vorteile', 'vorteil', 'nachteil', 'nachteile',
  'dankbar', 'begeistert', 'überzeugt', 'empfohlen',
  'bestätigt', 'verifiziert', 'zertifiziert',
  'deshalb', 'deswegen', 'darum', 'daher', 'trotzdem', 'dennoch',
  'starten', 'startet', 'gestartet', 'beginnt', 'begonnen',
  'perfekt', 'perfekte', 'perfekten', 'perfekter',
  'unterstützung', 'unterstützen', 'unterstützt',
  'genial', 'geniale', 'genialen', 'fantastisch', 'fantastische',
  'wissenschaftlich', 'nachgewiesen', 'belegt', 'studien',
  'millionen', 'tausende', 'hunderte',
  'gescheitert', 'geschafft', 'erreicht', 'gelöst', 'verändert',
  'dafür', 'dagegen', 'davon', 'daran', 'darauf', 'dabei',
  'oberste', 'obersten', 'oberster', 'höchste', 'höchsten',
  'priorität', 'prioritäten', 'hauptsache', 'fokus',
  'neujahrs', 'neujahrs-sale', 'weihnachts', 'oster', 'sommer',
  'zufriedene', 'begeisterte', 'überzeugte',
  'zusammen', 'gemeinsam', 'komplett', 'komplette', 'kompletten',
  'täglich', 'monatlich', 'wöchentlich', 'regelmäßig',
  'sogar', 'bereits', 'inzwischen', 'mittlerweile', 'endgültig',
  // More generic words that slip through
  'verdient', 'gesamte', 'gesamten', 'gesamter', 'gesamtes',
  'vorrat', 'vorräte', 'geschenk', 'geschenke',
  'neujahrs-geschenk', 'neujahrs-sale', 'neujahrs-aktion',
  'premium-produkte', 'premium-qualität', 'premium-produkt',
  'besondere', 'besonderen', 'besonderer', 'besonderes',
  'unglaublich', 'unglaubliche', 'unglaublichen',
  'passiert', 'aufgehört', 'angefangen', 'verändert',
  'tatsächlich', 'eigentlich', 'normalerweise', 'grundsätzlich',
  'produkte', 'produkt', 'nahrungsergänzung', 'nahrungsergänzungsmittel',
  'supplement', 'supplements', 'kapseln', 'tabletten', 'pulver',
  'zutat', 'zutaten', 'inhaltsstoffe', 'inhaltsstoff',
  // Conjugated verbs / forms that appear in generic ad copy
  'spitzenpreis', 'spitzenpreise', 'spitzenpreisen',
  'endet', 'enden', 'endete', 'beendet', 'beenden',
  'wenigen', 'weniger', 'weniges', 'wenigsten',
  'tagen', 'tages',
  'starte', 'startest', 'starten', 'gestartet',
  'nutze', 'nutzen', 'nutzt', 'genutzt',
  'erlebe', 'erleben', 'erlebt', 'erlebst',
  'lerne', 'lernen', 'lernt', 'gelernt',
  'teste', 'testen', 'testet', 'getestet',
  'spare', 'sparst', 'spart', 'gespart',
  'warte', 'warten', 'wartet', 'gewartet',
  'helfen', 'hilft', 'geholfen',
  'leiden', 'leidet', 'gelitten',
  'wirkt', 'wirken', 'gewirkt',
  'zeigen', 'zeigt', 'gezeigt',
  'bieten', 'bietet', 'geboten',
  'betroffen', 'betroffene', 'betroffenen', 'betroffener',
  'überzeugen', 'überzeugt', 'überzeuge',
  'versprochen', 'versprechen', 'verspricht',
  'empfehlen', 'empfiehlt', 'empfohlen',
  'holen', 'holst', 'holt', 'geholt',
  // More generic ad/marketing words
  'garantiert', 'geprüft', 'bewährt', 'beliebt', 'bekannt',
  'revolutionär', 'revolutionäre', 'revolutionären',
  'einzigartig', 'einzigartige', 'einzigartigen',
  'natürliche', 'natürlichen', 'natürlicher', 'natürliches',
  'wirkungsvolle', 'wirkungsvoller', 'wirkungsvoll',
  'positive', 'positiven', 'positiver', 'positives',
  'negative', 'negativen', 'negativer', 'negatives',
  'häufig', 'häufige', 'häufigen', 'häufiger',
  'einfache', 'einfachen', 'einfacher', 'einfaches',
  'schnelle', 'schnellen', 'schneller', 'schnelles',
  'gesund', 'gesunde', 'gesunden', 'gesunder', 'gesundes',
  'gesundheit', 'gesundheitlich', 'gesundheitliche',
  'wohlbefinden', 'wohlbefindens',
  'körper', 'körpers',
  'wirklich', 'wahre', 'wahren', 'wahrer', 'wahres',
  'sofortige', 'sofortigen', 'sofortiger',
  'höchste', 'höchster', 'höchstes',
  'verändern', 'veränderung', 'veränderungen',
  'verbessern', 'verbessert', 'verbesserung', 'verbesserungen',
  'erfahrung', 'erfahrungen', 'erfahrene', 'erfahrener',
  'lösung', 'lösungen',
  'bestellen', 'bestellbar', 'bestellungen',
  'sichern', 'gesichert',
  'begrenzt', 'begrenzte', 'begrenzten', 'begrenzter',
  'vertrauen', 'vertraut', 'vertraue',
  'empfinden', 'empfindet', 'empfunden',
  'zurück', 'zurückgeben', 'rückgabe',
  'risiko', 'risikofrei',
  'zufrieden', 'unzufrieden',
  'wunder', 'wunderbar', 'wunderbare', 'wunderbaren',
  'lager', 'lagerbestand', 'vorrätig', 'ausverkauft',
  'nachfrage', 'bedarf',
  'endlich', 'endliche',
  'sofort', 'sofortig',
  'sonderangebot', 'sonderaktion', 'sonderpreis',
  'neuheit', 'neuheiten', 'neuartig', 'neuartige',
  'beweis', 'beweise', 'bewiesen',
  'geheim', 'geheimnis', 'geheimnisse',
  'trick', 'tricks', 'tipps',
  // Very common German words that appear across all niches
  'gefühl', 'gefühle', 'gefühlen', 'gefühls',
  'innen', 'innere', 'inneren', 'innerer', 'inneres',
  'wieder', 'wiederum',
  'plus', 'minus',
  'balance', 'imbalance',
  'routine', 'routinen',
  'gleichgewicht',
  'wirksamkeit', 'wirkungsweise',
  'vitamin', 'vitamine', 'vitaminen',
  'zustand', 'zustände', 'zuständen',
  'kraft', 'kräfte', 'kräften',
  'energie', 'energien',
  'schönheit',
  'pflege', 'pflegen', 'gepflegt',
  'haut', 'haare', 'nägel', 'haar',
  'anti-aging', 'anti', 'aging',
  'strahlend', 'strahlende', 'strahlenden',
  'jugendlich', 'jugendliche', 'jugendlichen',
  'fühlen', 'fühlt', 'fühlst', 'gefühlt',
  'aussehen', 'aussieht',
  'wohlfühlen', 'wohlbefinden',
  // Generic words that still slip through in MiaVola/Glow25 tests
  'collections', 'collection', 'trotz', 'trotzdem',
  'eingenommene', 'eingenommen', 'eingenommenen',
  'aktive', 'aktiven', 'aktiver', 'aktives', 'aktivem',
  'allein', 'alleine', 'einzeln', 'solo',
  'bundles', 'bundle', 'kombination', 'kombinationen',
  'calcium', 'magnesium', 'zink', 'eisen', 'jod', 'selen',
  'darm', 'darmflora', 'verdauung',
  'müde', 'müdigkeit', 'erschöpft', 'erschöpfung',
  'schlaf', 'schlafen', 'schlafqualität',
  'stress', 'stressig', 'entspannung', 'entspannt',
  'immunsystem', 'abwehrkräfte', 'immunabwehr',
  'stoffwechsel', 'metabolismus',
  'abnehmen', 'gewicht', 'diät', 'figur',
  'muskel', 'muskeln', 'muskelaufbau',
  'gelenke', 'gelenk', 'gelenkschmerzen',
  'entzündung', 'entzündungen', 'entzündlich',
  'symptome', 'symptom', 'beschwerden', 'beschwerde',
  'diagnose', 'therapie', 'behandlung', 'behandlungen',
  'arzt', 'ärzte', 'ärztin', 'ärztlich', 'ärztliche',
  'studie', 'studien', 'forschung', 'wissenschaft',
  'wirkstoff', 'wirkstoffe', 'wirkstoffkomplex',
  // Very common German words / verb forms that slip through
  'etwas', 'kannst', 'könnte', 'könnten', 'sollte', 'sollten',
  'trotz', 'trotzdem', 'obwohl', 'dennoch',
  'davon', 'dafür', 'daran', 'darauf', 'dabei', 'damit',
  'vorverkauf', 'mengenrabatt', 'rabattcode', 'gutscheincode',
  'angebote', 'angeboten', 'aktion', 'aktionen',

  // English generic ad phrases
  'click', 'buy', 'order', 'shop', 'now', 'today', 'free', 'shipping',
  'discount', 'sale', 'offer', 'deal', 'save', 'price', 'limited',
  'exclusive', 'premium', 'original', 'authentic',
  'learn', 'more', 'discover', 'explore', 'check', 'out',
  'available', 'delivery', 'fast', 'easy', 'simple',
  'best', 'better', 'great', 'good', 'amazing', 'awesome',
  'customers', 'customer', 'review', 'reviews', 'rated',
]);

/**
 * Generate product keywords from brand ads.
 *
 * Analyzes ad copy to find product-related terms that third-party
 * advertisers would also use in their ads.
 *
 * @param ads - Brand's own ads from Meta API
 * @param brandName - Brand name to exclude from keywords
 * @param maxKeywords - Maximum keywords to return (default 10)
 */
export function generateKeywords(
  ads: MetaAd[],
  brandName: string,
  maxKeywords: number = 10
): KeywordGeneratorResult {
  const wordScores = new Map<string, { frequency: number; sources: Set<string> }>();
  const brandLower = brandName.toLowerCase();
  const brandNormalized = brandLower.replace(/[\s\-_.]+/g, '');

  // Process all ad texts
  for (const ad of ads) {
    // Body texts (highest weight)
    if (ad.ad_creative_bodies) {
      for (const body of ad.ad_creative_bodies) {
        extractAndScoreWords(body, 'body', wordScores, brandLower, brandNormalized);
      }
    }

    // Link titles
    if (ad.ad_creative_link_titles) {
      for (const title of ad.ad_creative_link_titles) {
        extractAndScoreWords(title, 'title', wordScores, brandLower, brandNormalized);
      }
    }

    // Link descriptions
    if (ad.ad_creative_link_descriptions) {
      for (const desc of ad.ad_creative_link_descriptions) {
        extractAndScoreWords(desc, 'description', wordScores, brandLower, brandNormalized);
      }
    }
  }

  // Convert to sorted array
  // Adaptive frequency threshold: at least 3, or 0.5% of ads analyzed (whichever is higher)
  const minFrequency = Math.max(3, Math.ceil(ads.length * 0.005));
  const sorted = [...wordScores.entries()]
    .filter(([, score]) => score.frequency >= minFrequency)
    .sort((a, b) => b[1].frequency - a[1].frequency)
    .slice(0, maxKeywords);

  const keywords = sorted.map(([word]) => word);
  const keyword_scores = sorted.map(([word, score]) => ({
    keyword: word,
    frequency: score.frequency,
    source: [...score.sources][0] as 'body' | 'title' | 'description',
  }));

  // Generate 2-word compound keywords
  const compoundKeywords = generateCompoundKeywords(ads, brandLower, brandNormalized);

  // Merge: single keywords first (more reliable), then compounds to fill
  const finalKeywords: string[] = [];
  const finalScores: KeywordGeneratorResult['keyword_scores'] = [];

  // Add single keywords first (they're more reliable for Meta API search)
  for (let i = 0; i < keywords.length && finalKeywords.length < maxKeywords; i++) {
    if (!finalKeywords.includes(keywords[i])) {
      finalKeywords.push(keywords[i]);
      finalScores.push(keyword_scores[i]);
    }
  }

  // Fill remaining with compound keywords (more specific, better for niche)
  for (const ck of compoundKeywords) {
    if (finalKeywords.length >= maxKeywords) break;
    // Skip compound if both words already in singles
    const parts = ck.keyword.toLowerCase().split(' ');
    const bothPartsInSingles = parts.every(p =>
      finalKeywords.some(fk => fk.toLowerCase() === p)
    );
    if (!bothPartsInSingles && !finalKeywords.includes(ck.keyword)) {
      finalKeywords.push(ck.keyword);
      finalScores.push(ck);
    }
  }

  return {
    keywords: finalKeywords,
    keyword_scores: finalScores,
    total_ads_analyzed: ads.length,
  };
}

/**
 * Extract words from text, score them, and add to the map
 */
function extractAndScoreWords(
  text: string,
  source: string,
  scores: Map<string, { frequency: number; sources: Set<string> }>,
  brandLower: string,
  brandNormalized: string
): void {
  if (!text) return;

  // Split into words, keep only meaningful ones
  const words = text
    .replace(/[^\wäöüßÄÖÜ\s-]/g, ' ') // Keep umlauts, hyphens
    .split(/\s+/)
    .filter(w => w.length >= 4) // Min 4 chars (filters short noise)
    .map(w => w.toLowerCase().trim())
    .filter(w => !/^\d+$/.test(w)) // No pure numbers (2024, 2025, etc.)
    .filter(w => !/^\d/.test(w)) // No words starting with digits
    .filter(w => !isStopWord(w))
    .filter(w => !isGenericAdWord(w))
    .filter(w => !isBrandWord(w, brandLower, brandNormalized));

  for (const word of words) {
    const existing = scores.get(word);
    if (existing) {
      existing.frequency++;
      existing.sources.add(source);
    } else {
      scores.set(word, { frequency: 1, sources: new Set([source]) });
    }
  }
}

/**
 * Generate 2-word compound keywords (e.g., "Schilddrüse Test", "Nagelpflege Set")
 */
function generateCompoundKeywords(
  ads: MetaAd[],
  brandLower: string,
  brandNormalized: string
): Array<{ keyword: string; frequency: number; source: 'body' | 'title' | 'description' }> {
  const bigramCounts = new Map<string, number>();

  for (const ad of ads) {
    const texts: string[] = [];
    if (ad.ad_creative_bodies) texts.push(...ad.ad_creative_bodies);
    if (ad.ad_creative_link_titles) texts.push(...ad.ad_creative_link_titles);

    for (const text of texts) {
      const words = text
        .replace(/[^\wäöüßÄÖÜ\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 4) // Min 4 chars
        .map(w => w.toLowerCase().trim())
        .filter(w => !/^\d+$/.test(w)) // No pure numbers
        .filter(w => !/^\d/.test(w)) // No words starting with digits
        .filter(w => !isStopWord(w))
        .filter(w => !isBrandWord(w, brandLower, brandNormalized));

      // Create bigrams
      for (let i = 0; i < words.length - 1; i++) {
        // Skip if either word is generic ad word
        if (isGenericAdWord(words[i]) || isGenericAdWord(words[i + 1])) continue;
        // Skip duplicate word bigrams (e.g., "Jahr Jahr")
        if (words[i] === words[i + 1]) continue;

        const bigram = `${capitalize(words[i])} ${capitalize(words[i + 1])}`;
        bigramCounts.set(bigram, (bigramCounts.get(bigram) || 0) + 1);
      }
    }
  }

  return [...bigramCounts.entries()]
    .filter(([, count]) => count >= 3) // Higher threshold for bigrams
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([keyword, frequency]) => ({
      keyword,
      frequency,
      source: 'body' as const,
    }));
}

function isStopWord(word: string): boolean {
  return GERMAN_STOP_WORDS.has(word) || ENGLISH_STOP_WORDS.has(word);
}

function isGenericAdWord(word: string): boolean {
  return GENERIC_AD_WORDS.has(word);
}

function isBrandWord(word: string, brandLower: string, brandNormalized: string): boolean {
  const wordNormalized = word.replace(/[\s\-_.]+/g, '');
  return (
    word === brandLower ||
    wordNormalized === brandNormalized ||
    brandLower.includes(word) ||
    word.includes(brandLower)
  );
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// ============================================
// AI Keyword Refinement (OpenAI GPT-4o-mini)
// ============================================

/**
 * Refine keywords using AI (GPT-4o-mini).
 * Takes candidate keywords from ad text extraction and selects the most
 * product-niche-specific ones that competitors/affiliates would also use.
 *
 * @param candidates - Raw candidate keywords from extractAndScoreWords
 * @param brandName - Brand name (e.g., "Glow25 - The Collagen Company")
 * @param brandPageName - Official page name for context
 * @param maxKeywords - Max keywords to return
 * @param openaiKey - OpenAI API key
 * @returns Refined keyword list, or null if AI call fails
 */
export async function refineKeywordsWithAI(
  candidates: string[],
  brandName: string,
  brandPageName: string,
  maxKeywords: number = 8,
  openaiKey?: string
): Promise<string[] | null> {
  if (!openaiKey) return null;
  if (candidates.length === 0) return null;

  try {
    const prompt = `Du bist ein Marketing-Analyst für Facebook-Werbung. Die Marke "${brandName}" (Facebook-Seite: "${brandPageName}") schaltet Werbeanzeigen.

Aus den Werbetexten der Marke wurden diese Wörter/Begriffe extrahiert (sortiert nach Häufigkeit):
${candidates.slice(0, 40).join(', ')}

Aufgabe: Wähle die ${maxKeywords} besten NISCHEN-KEYWORDS aus, die:
1. Spezifisch für die PRODUKTKATEGORIE/NISCHE dieser Marke sind
2. Von Drittanbietern/Affiliates/Presell-Seiten dieser Marke auch in deren Facebook-Werbung verwendet würden
3. NICHT zu generisch sind (keine allgemeinen Wörter wie "Gesundheit", "Qualität", "Angebot")
4. Als Meta Ad Library Suchbegriffe funktionieren (einzelne Wörter oder kurze Phrasen)

Wenn die Kandidaten-Liste KEINE guten Nischen-Keywords enthält, generiere selbst 3-5 passende Keywords basierend auf dem Markennamen und der Produktkategorie.

Antworte NUR mit den Keywords, eines pro Zeile, ohne Nummerierung oder Erklärung.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 200,
      }),
    });

    if (!response.ok) {
      console.log(`[Keywords] AI refinement failed: HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    const refined = content
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line.length >= 3 && line.length <= 40)
      .filter((line: string) => !/^\d+[\.\)]/.test(line)) // Remove numbered lines
      .map((line: string) => line.replace(/^[-•*]\s*/, '').trim()) // Remove bullet points
      .filter((line: string) => line.length >= 3)
      .slice(0, maxKeywords);

    console.log(`[Keywords] AI refined: ${JSON.stringify(refined)} (from ${candidates.length} candidates)`);
    return refined.length > 0 ? refined : null;

  } catch (error) {
    console.log(`[Keywords] AI refinement error: ${error}`);
    return null;
  }
}
