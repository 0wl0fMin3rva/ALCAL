// AlCal daily line: one entry per day, same entry on every device for a given date.
// Fields: t = text (\n = line break), a = author, s = source, y = year (original), tr = translator (optional)
const QUOTES = [
  // Hölderlin
  {a:'Friedrich Hölderlin', s:'Patmos', y:'1803', t:'Wo aber Gefahr ist, wächst\nDas Rettende auch.'},
  {a:'Friedrich Hölderlin', s:'Patmos', y:'1803', t:'Nah ist\nUnd schwer zu fassen der Gott.'},
  {a:'Friedrich Hölderlin', s:'Andenken', y:'1803', t:'Was bleibet aber, stiften die Dichter.'},
  {a:'Friedrich Hölderlin', s:'Hälfte des Lebens', y:'1804', t:'Weh mir, wo nehm’ ich, wenn\nEs Winter ist, die Blumen, und wo\nDen Sonnenschein,\nUnd Schatten der Erde?\nDie Mauern stehn\nSprachlos und kalt, im Winde\nKlirren die Fahnen.'},
  {a:'Friedrich Hölderlin', s:'Der Gang aufs Land', y:'1800', t:'Komm! ins Offene, Freund!'},
  {a:'Friedrich Hölderlin', s:'In lieblicher Bläue', y:'c. 1808', t:'Voll Verdienst, doch dichterisch, wohnet\nDer Mensch auf dieser Erde.'},
  {a:'Friedrich Hölderlin', s:'Hyperion', y:'1797', t:'Wir sind nichts; was wir suchen, ist alles.'},
  // Rilke
  {a:'Rainer Maria Rilke', s:'Archaïscher Torso Apollos, Der neuen Gedichte anderer Teil', y:'1908', t:'denn da ist keine Stelle,\ndie dich nicht sieht. Du mußt dein Leben ändern.'},
  {a:'Rainer Maria Rilke', s:'Herbsttag, Das Buch der Bilder', y:'1902', t:'Wer jetzt kein Haus hat, baut sich keines mehr.\nWer jetzt allein ist, wird es lange bleiben.'},
  {a:'Rainer Maria Rilke', s:'Duineser Elegien, I', y:'1923', t:'Denn das Schöne ist nichts\nals des Schrecklichen Anfang, den wir noch grade ertragen.'},
  {a:'Rainer Maria Rilke', s:'Duineser Elegien, I', y:'1923', t:'Wer, wenn ich schriee, hörte mich denn aus der Engel\nOrdnungen?'},
  {a:'Rainer Maria Rilke', s:'Das Stunden-Buch', y:'1905', t:'Ich lebe mein Leben in wachsenden Ringen,\ndie sich über die Dinge ziehn.'},
  {a:'Rainer Maria Rilke', s:'Die Sonette an Orpheus, I, 3', y:'1923', t:'Gesang ist Dasein.'},
  {a:'Rainer Maria Rilke', s:'Der Panther, Neue Gedichte', y:'1907', t:'Ihm ist, als ob es tausend Stäbe gäbe\nund hinter tausend Stäben keine Welt.'},
  {a:'Rainer Maria Rilke', s:'Briefe an einen jungen Dichter', y:'1929', t:'Geduld zu haben gegen alles Ungelöste in Ihrem Herzen und zu versuchen, die Fragen selbst liebzuhaben.'},
  // Trakl
  {a:'Georg Trakl', s:'Frühling der Seele, Sebastian im Traum', y:'1915', t:'Es ist die Seele ein Fremdes auf Erden.'},
  {a:'Georg Trakl', s:'Grodek', y:'1915', t:'Die heiße Flamme des Geistes nährt heute ein gewaltiger Schmerz,\nDie ungebornen Enkel.'},
  {a:'Georg Trakl', s:'Ein Winterabend', y:'1913', t:'Wanderer tritt still herein;\nSchmerz versteinerte die Schwelle.\nDa erglänzt in reiner Helle\nAuf dem Tische Brot und Wein.'},
  {a:'Georg Trakl', s:'Verklärter Herbst, Gedichte', y:'1913', t:'Gewaltig endet so das Jahr\nMit goldnem Wein und Frucht der Gärten.'},
  // Nietzsche
  {a:'Friedrich Nietzsche', s:'Götzen-Dämmerung, Sprüche und Pfeile 33', y:'1889', t:'Ohne Musik wäre das Leben ein Irrthum.'},
  {a:'Friedrich Nietzsche', s:'Götzen-Dämmerung, Sprüche und Pfeile 8', y:'1889', t:'Aus der Kriegsschule des Lebens. – Was mich nicht umbringt, macht mich stärker.'},
  {a:'Friedrich Nietzsche', s:'Also sprach Zarathustra, Vorrede 5', y:'1883', t:'Ich sage euch: man muss noch Chaos in sich haben, um einen tanzenden Stern gebären zu können.'},
  {a:'Friedrich Nietzsche', s:'Jenseits von Gut und Böse, 146', y:'1886', t:'Wer mit Ungeheuern kämpft, mag zusehn, dass er nicht dabei zum Ungeheuer wird. Und wenn du lange in einen Abgrund blickst, blickt der Abgrund auch in dich hinein.'},
  {a:'Friedrich Nietzsche', s:'Jenseits von Gut und Böse, 108', y:'1886', t:'Es giebt gar keine moralischen Phänomene, sondern nur eine moralische Ausdeutung von Phänomenen.'},
  {a:'Friedrich Nietzsche', s:'Über Wahrheit und Lüge im aussermoralischen Sinne', y:'1873', t:'Was ist also Wahrheit? Ein bewegliches Heer von Metaphern, Metonymien, Anthropomorphismen.'},
  // Wittgenstein
  {a:'Ludwig Wittgenstein', s:'Tractatus logico-philosophicus, 1', y:'1921', t:'Die Welt ist alles, was der Fall ist.'},
  {a:'Ludwig Wittgenstein', s:'Tractatus logico-philosophicus, 5.6', y:'1921', t:'Die Grenzen meiner Sprache bedeuten die Grenzen meiner Welt.'},
  {a:'Ludwig Wittgenstein', s:'Tractatus logico-philosophicus, 7', y:'1921', t:'Wovon man nicht sprechen kann, darüber muß man schweigen.'},
  {a:'Ludwig Wittgenstein', s:'Tractatus logico-philosophicus, 6.44', y:'1921', t:'Nicht wie die Welt ist, ist das Mystische, sondern daß sie ist.'},
  {a:'Ludwig Wittgenstein', s:'Tractatus logico-philosophicus, 6.52', y:'1921', t:'Wir fühlen, daß selbst, wenn alle möglichen wissenschaftlichen Fragen beantwortet sind, unsere Lebensprobleme noch gar nicht berührt sind.'},
  {a:'Ludwig Wittgenstein', s:'Tractatus logico-philosophicus, 4.112', y:'1921', t:'Die Philosophie ist keine Lehre, sondern eine Tätigkeit.'},
  {a:'Ludwig Wittgenstein', s:'Tractatus logico-philosophicus, 6.4311', y:'1921', t:'Wenn man unter Ewigkeit nicht unendliche Zeitdauer, sondern Unzeitlichkeit versteht, dann lebt der ewig, der in der Gegenwart lebt.'},
  // Benjamin
  {a:'Walter Benjamin', s:'Einbahnstraße', y:'1928', t:'Die Arbeit an einer guten Prosa hat drei Stufen: eine musikalische, auf der sie komponiert, eine architektonische, auf der sie gebaut, endlich eine textile, auf der sie gewoben wird.'},
  {a:'Walter Benjamin', s:'Einbahnstraße', y:'1928', t:'Überzeugen ist unfruchtbar.'},
  {a:'Walter Benjamin', s:'Die Aufgabe des Übersetzers', y:'1923', t:'Kein Gedicht gilt dem Leser, kein Bild dem Beschauer, keine Symphonie der Hörerschaft.'},
  {a:'Walter Benjamin', s:'Ursprung des deutschen Trauerspiels', y:'1928', t:'Die Allegorien sind im Reiche der Gedanken, was die Ruinen im Reiche der Dinge.'},
  {a:'Walter Benjamin', s:'Ursprung des deutschen Trauerspiels, Vorrede', y:'1928', t:'Die Wahrheit ist der Tod der Intention.'},
  {a:'Walter Benjamin', s:'Ursprung des deutschen Trauerspiels, Vorrede', y:'1928', t:'Methode ist Umweg.'},
  // Heidegger
  {a:'Martin Heidegger', s:'Sein und Zeit, § 2', y:'1927', t:'Jedes Fragen ist ein Suchen.'},
  {a:'Martin Heidegger', s:'Sein und Zeit, § 2', y:'1927', t:'Das Sein des Seienden »ist« nicht selbst ein Seiendes.'},
  {a:'Martin Heidegger', s:'Sein und Zeit, § 28', y:'1927', t:'Das Dasein ist seine Erschlossenheit.'},
  {a:'Martin Heidegger', s:'Was ist Metaphysik?', y:'1929', t:'Das Nichts selbst nichtet.'},
  {a:'Martin Heidegger', s:'Was ist Metaphysik?', y:'1929', t:'Warum ist überhaupt Seiendes und nicht vielmehr Nichts?'},
  // Hegel
  {a:'G. W. F. Hegel', s:'Grundlinien der Philosophie des Rechts, Vorrede', y:'1820', t:'Die Eule der Minerva beginnt erst mit der einbrechenden Dämmerung ihren Flug.'},
  {a:'G. W. F. Hegel', s:'Grundlinien der Philosophie des Rechts, Vorrede', y:'1820', t:'Was vernünftig ist, das ist wirklich;\nund was wirklich ist, das ist vernünftig.'},
  {a:'G. W. F. Hegel', s:'Phänomenologie des Geistes, Vorrede', y:'1807', t:'Das Wahre ist das Ganze.'},
  {a:'G. W. F. Hegel', s:'Phänomenologie des Geistes, Vorrede', y:'1807', t:'Das Bekannte überhaupt ist darum, weil es bekannt ist, nicht erkannt.'},
  {a:'G. W. F. Hegel', s:'Phänomenologie des Geistes, Vorrede', y:'1807', t:'… die Nacht, worin, wie man zu sagen pflegt, alle Kühe schwarz sind.'},
  {a:'G. W. F. Hegel', s:'Vorlesungen über die Philosophie der Geschichte', y:'1837', t:'… daß nichts Großes in der Welt ohne Leidenschaft vollbracht worden ist.'},
  // Hume
  {a:'David Hume', s:'A Treatise of Human Nature, 2.3.3', y:'1739', t:'Reason is, and ought only to be the slave of the passions, and can never pretend to any other office than to serve and obey them.'},
  {a:'David Hume', s:'Of the Standard of Taste', y:'1757', t:'Beauty is no quality in things themselves: It exists merely in the mind which contemplates them; and each mind perceives a different beauty.'},
  {a:'David Hume', s:'An Enquiry concerning Human Understanding, X', y:'1748', t:'A wise man, therefore, proportions his belief to the evidence.'},
  {a:'David Hume', s:'An Enquiry concerning Human Understanding, V', y:'1748', t:'Custom, then, is the great guide of human life.'},
  {a:'David Hume', s:'An Enquiry concerning Human Understanding, I', y:'1748', t:'Be a philosopher; but, amidst all your philosophy, be still a man.'},
  {a:'David Hume', s:'An Enquiry concerning Human Understanding, XII', y:'1748', t:'Commit it then to the flames: for it can contain nothing but sophistry and illusion.'},
  // Musil
  {a:'Robert Musil', s:'Der Mann ohne Eigenschaften, I, 4', y:'1930', t:'Wenn es aber Wirklichkeitssinn gibt, und niemand wird bezweifeln, daß er seine Daseinsberechtigung hat, dann muß es auch etwas geben, das man Möglichkeitssinn nennen kann.'},
  {a:'Robert Musil', s:'Der Mann ohne Eigenschaften, I, 4', y:'1930', t:'… denn es ist die Wirklichkeit, welche die Möglichkeiten weckt, und nichts wäre so verkehrt, wie das zu leugnen.'},
  {a:'Robert Musil', s:'Der Mann ohne Eigenschaften, I, 1', y:'1930', t:'Mit einem Wort, das das Tatsächliche zwar recht gut bezeichnet, aber etwas altmodisch ist: Es war ein schöner Augusttag des Jahres 1913.'},
  // Hart Crane
  {a:'Hart Crane', s:'Voyages I, White Buildings', y:'1926', t:'The bottom of the sea is cruel.'},
  {a:'Hart Crane', s:'Voyages III, White Buildings', y:'1926', t:'Permit me voyage, love, into your hands …'},
  {a:'Hart Crane', s:'At Melville’s Tomb, White Buildings', y:'1926', t:'This fabulous shadow only the sea keeps.'},
  {a:'Hart Crane', s:'Legend, White Buildings', y:'1926', t:'As silent as a mirror is believed\nRealities plunge in silence by …'},
  {a:'Hart Crane', s:'To Brooklyn Bridge, The Bridge', y:'1930', t:'And of the curveship lend a myth to God.'},
  // Heraclitus (tr. John Burnet, Early Greek Philosophy)
  {a:'Heraclitus', s:'Fragment DK B 91', y:'c. 500 BCE', tr:'John Burnet', t:'You cannot step twice into the same rivers; for fresh waters are ever flowing in upon you.'},
  {a:'Heraclitus', s:'Fragment DK B 60', y:'c. 500 BCE', tr:'John Burnet', t:'The way up and the way down is one and the same.'},
  {a:'Heraclitus', s:'Fragment DK B 123', y:'c. 500 BCE', tr:'John Burnet', t:'Nature loves to hide.'},
  {a:'Heraclitus', s:'Fragment DK B 54', y:'c. 500 BCE', tr:'John Burnet', t:'The hidden attunement is better than the open.'},
  {a:'Heraclitus', s:'Fragment DK B 52', y:'c. 500 BCE', tr:'John Burnet', t:'Time is a child playing draughts, the kingly power is a child’s.'},
  {a:'Heraclitus', s:'Fragment DK B 53', y:'c. 500 BCE', tr:'John Burnet', t:'War is the father of all and the king of all; and some he has made gods and some men, some bond and some free.'},
  // Aristotle
  {a:'Aristotle', s:'Metaphysics, I.1', y:'c. 350 BCE', tr:'W. D. Ross', t:'All men by nature desire to know.'},
  {a:'Aristotle', s:'Metaphysics, I.2', y:'c. 350 BCE', tr:'W. D. Ross', t:'For it is owing to their wonder that men both now and at first began to philosophize.'},
  {a:'Aristotle', s:'Nicomachean Ethics, I.7', y:'c. 340 BCE', tr:'W. D. Ross', t:'For one swallow does not make a summer, nor does one day; and so too one day, or a short time, does not make a man blessed and happy.'},
  {a:'Aristotle', s:'Nicomachean Ethics, II.1', y:'c. 340 BCE', tr:'W. D. Ross', t:'For the things we have to learn before we can do them, we learn by doing them.'},
  {a:'Aristotle', s:'Politics, I.2', y:'c. 330 BCE', tr:'Benjamin Jowett', t:'Man is by nature a political animal.'},
  // Laozi (tr. James Legge, 1891)
  {a:'Laozi', s:'Dao De Jing, 1', y:'c. 4th c. BCE', tr:'James Legge', t:'The Tao that can be trodden is not the enduring and unchanging Tao. The name that can be named is not the enduring and unchanging name.'},
  {a:'Laozi', s:'Dao De Jing, 11', y:'c. 4th c. BCE', tr:'James Legge', t:'The thirty spokes unite in the one nave; but it is on the empty space (for the axle), that the use of the wheel depends.'},
  {a:'Laozi', s:'Dao De Jing, 33', y:'c. 4th c. BCE', tr:'James Legge', t:'He who knows other men is discerning; he who knows himself is intelligent.'},
  {a:'Laozi', s:'Dao De Jing, 64', y:'c. 4th c. BCE', tr:'James Legge', t:'The journey of a thousand li commenced with a single step.'},
  {a:'Laozi', s:'Dao De Jing, 78', y:'c. 4th c. BCE', tr:'James Legge', t:'There is nothing in the world more soft and weak than water, and yet for attacking things that are firm and strong there is nothing that can take precedence of it.'},
  // Confucius (tr. James Legge, 1861)
  {a:'Confucius', s:'Analects, II.17', y:'c. 5th c. BCE', tr:'James Legge', t:'When you know a thing, to hold that you know it; and when you do not know a thing, to allow that you do not know it; this is knowledge.'},
  {a:'Confucius', s:'Analects, II.15', y:'c. 5th c. BCE', tr:'James Legge', t:'Learning without thought is labour lost; thought without learning is perilous.'},
  {a:'Confucius', s:'Analects, XV.23', y:'c. 5th c. BCE', tr:'James Legge', t:'What you do not want done to yourself, do not do to others.'},
  {a:'Confucius', s:'Analects, IX.16', y:'c. 5th c. BCE', tr:'James Legge', t:'It passes on just like this, not ceasing day or night!'},
  {a:'Confucius', s:'Analects, I.1', y:'c. 5th c. BCE', tr:'James Legge', t:'Is it not pleasant to learn with a constant perseverance and application?'},
  // Zhuangzi (tr. Herbert A. Giles, 1889)
  {a:'Zhuangzi', s:'Zhuangzi, ch. 2', y:'c. 3rd c. BCE', tr:'Herbert A. Giles', t:'Now I do not know whether I was then a man dreaming I was a butterfly, or whether I am now a butterfly, dreaming I am a man.'},
  {a:'Zhuangzi', s:'Zhuangzi, ch. 17', y:'c. 3rd c. BCE', tr:'Herbert A. Giles', t:'“You not being a fish yourself,” said Hui Tzŭ, “how can you possibly know in what consists the pleasure of fishes?” “And you not being I,” retorted Chuang Tzŭ, “how can you know that I do not know?”'},
  {a:'Zhuangzi', s:'Zhuangzi, ch. 26', y:'c. 3rd c. BCE', tr:'Herbert A. Giles', t:'The object of words is to convey ideas; when the ideas are grasped, the words are forgotten.'},
  // Li Bai (tr. Witter Bynner, The Jade Mountain, 1929)
  {a:'Li Bai', s:'In the Quiet Night', y:'c. 726', tr:'Witter Bynner', t:'So bright a gleam on the foot of my bed –\nCould there have been a frost already?\nLifting myself to look, I found that it was moonlight.\nSinking back again, I thought suddenly of home.'},
  {a:'Li Bai', s:'Drinking Alone with the Moon', y:'c. 744', tr:'Witter Bynner', t:'From a pot of wine among the flowers\nI drank alone. There was no one with me –\nTill, raising my cup, I asked the bright moon\nTo bring me my shadow and make us three.'},
  {a:'Li Bai', s:'A Farewell to Meng Haoran on His Way to Yangzhou', y:'c. 730', tr:'Witter Bynner', t:'Your sail, a single shadow, becomes one with the blue sky,\nTill now I see only the river, on its way to heaven.'},
  // Du Fu (tr. Witter Bynner, The Jade Mountain, 1929)
  {a:'Du Fu', s:'A Spring View', y:'757', tr:'Witter Bynner', t:'Though a country be sundered, hills and rivers endure;\nAnd spring comes green again to trees and grasses\nWhere petals have been shed like tears\nAnd lonely birds have sung their grief.'},
  {a:'Du Fu', s:'A Night Abroad', y:'765', tr:'Witter Bynner', t:'Flitting, flitting, what am I like\nBut a sand-snipe in the wide, wide world!'},
  {a:'Du Fu', s:'To My Retired Friend Wei', y:'759', tr:'Witter Bynner', t:'It is almost as hard for friends to meet\nAs for the morning and evening stars.'}
];

// Fixed shuffle (seeded), so consecutive days rarely share an author, then one entry per local calendar day.
const QUOTE_ORDER = (() => {
  const idx = QUOTES.map((_, i) => i);
  let s = 20261106;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  for(let i = idx.length - 1; i > 0; i--){ const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  for(let i = 1; i < idx.length; i++){            // nudge apart same-author neighbours
    if(QUOTES[idx[i]].a === QUOTES[idx[i-1]].a){
      for(let k = i + 1; k < idx.length; k++){
        if(QUOTES[idx[k]].a !== QUOTES[idx[i-1]].a){ [idx[i], idx[k]] = [idx[k], idx[i]]; break; }
      }
    }
  }
  return idx;
})();

function quoteForDate(d){
  const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
  return QUOTES[QUOTE_ORDER[((day % QUOTE_ORDER.length) + QUOTE_ORDER.length) % QUOTE_ORDER.length]];
}

function renderDailyQuote(){
  const el = document.getElementById('daily');
  if(!el) return;
  const d = new Date(), key = d.toDateString();
  if(el.dataset.day === key) return;
  el.dataset.day = key;
  const q = quoteForDate(d);
  const esc = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const lang = (q.tr || /Hume|Crane/.test(q.a)) ? 'en' : 'de';
  el.innerHTML = '<blockquote lang="' + lang + '">' + esc(q.t).replace(/\n/g, '<br>') + '</blockquote>' +
    '<div class="by">' + esc(q.a) + '</div>' +
    '<div class="src">' + esc(q.s) + ', ' + esc(q.y) + (q.tr ? ' · tr. ' + esc(q.tr) : '') + '</div>';
}
renderDailyQuote();
setInterval(renderDailyQuote, 60000);
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') renderDailyQuote(); });
