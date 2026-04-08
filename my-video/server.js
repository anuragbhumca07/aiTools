'use strict';

const express = require('express');
const { exec } = require('child_process');
const { spawn } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3001;

// CORS — allow Cloudflare Pages frontend
app.use((req, res, next) => {
  const origin = process.env.FRONTEND_URL || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));
app.use('/videos', express.static(path.join(__dirname, 'out')));

// Health check for UptimeRobot / Railway
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─── Question Bank ─────────────────────────────────────────────────
const QUESTION_BANK = {
  Maths: {
    Primary: [
      { question: "What is 7 + 5?", options: ["11", "13", "12", "10"], correctIndex: 2 },
      { question: "What is 15 - 8?", options: ["6", "9", "8", "7"], correctIndex: 3 },
      { question: "What is 4 × 3?", options: ["12", "10", "14", "8"], correctIndex: 0 },
      { question: "What is 20 ÷ 4?", options: ["6", "4", "8", "5"], correctIndex: 3 },
      { question: "How many sides does a rectangle have?", options: ["3", "5", "6", "4"], correctIndex: 3 },
      { question: "What is half of 18?", options: ["8", "10", "9", "7"], correctIndex: 2 },
    ],
    "Middle School": [
      { question: "What is 25% of 80?", options: ["15", "20", "25", "30"], correctIndex: 1 },
      { question: "What is the square root of 144?", options: ["11", "14", "12", "13"], correctIndex: 2 },
      { question: "If x + 5 = 12, what is x?", options: ["5", "8", "6", "7"], correctIndex: 3 },
      { question: "What is 2 to the power of 3?", options: ["6", "9", "8", "12"], correctIndex: 2 },
      { question: "What is the LCM of 4 and 6?", options: ["10", "8", "12", "24"], correctIndex: 2 },
    ],
    "High School": [
      { question: "What is the derivative of x squared?", options: ["x", "2", "x divided by 2", "2x"], correctIndex: 3 },
      { question: "What is sin of 90 degrees?", options: ["0", "0.5", "negative 1", "1"], correctIndex: 3 },
      { question: "What is log base 10 of 1000?", options: ["2", "4", "3", "10"], correctIndex: 2 },
      { question: "Sum of interior angles of a triangle?", options: ["90 degrees", "360 degrees", "270 degrees", "180 degrees"], correctIndex: 3 },
      { question: "What is the slope of y equals 3x plus 2?", options: ["2", "1", "3", "5"], correctIndex: 2 },
    ],
    College: [
      { question: "What is the integral of x dx?", options: ["x squared plus C", "x squared over 2 plus C", "2x plus C", "x over 2 plus C"], correctIndex: 1 },
      { question: "What is the determinant of the 2x2 identity matrix?", options: ["0", "negative 1", "2", "1"], correctIndex: 3 },
      { question: "What does the Central Limit Theorem describe?", options: ["Population growth", "All data is normal", "Sample means follow normal distribution", "Variance equals mean"], correctIndex: 2 },
      { question: "What is Euler's number e approximately equal to?", options: ["3.14", "2.72", "1.41", "1.73"], correctIndex: 1 },
      { question: "In statistics, what is the median?", options: ["Most frequent value", "Sum divided by count", "Middle value", "Largest value"], correctIndex: 2 },
    ],
  },
  Science: {
    Physics: [
      { question: "What is the speed of light approximately?", options: ["150,000 km/s", "200,000 km/s", "400,000 km/s", "300,000 km/s"], correctIndex: 3 },
      { question: "What is the unit of force?", options: ["Watt", "Pascal", "Joule", "Newton"], correctIndex: 3 },
      { question: "Kinetic energy depends on what?", options: ["Temperature", "Mass and velocity", "Volume", "Color"], correctIndex: 1 },
      { question: "What does Newton's 3rd Law state?", options: ["F equals ma", "Objects in motion stay in motion", "Every action has an equal and opposite reaction", "Energy is conserved"], correctIndex: 2 },
      { question: "What is the unit of electrical resistance?", options: ["Volt", "Ampere", "Watt", "Ohm"], correctIndex: 3 },
    ],
    Chemistry: [
      { question: "What is the chemical symbol for gold?", options: ["Go", "Gl", "Gd", "Au"], correctIndex: 3 },
      { question: "What is the atomic number of Carbon?", options: ["4", "6", "8", "12"], correctIndex: 1 },
      { question: "What is H2O?", options: ["Hydrogen gas", "Salt", "Water", "Oxygen"], correctIndex: 2 },
      { question: "What is the most abundant gas in Earth's atmosphere?", options: ["Oxygen", "Argon", "Carbon dioxide", "Nitrogen"], correctIndex: 3 },
      { question: "Which of these is a noble gas?", options: ["Chlorine", "Sodium", "Helium", "Fluorine"], correctIndex: 2 },
    ],
    Biology: [
      { question: "How many chambers does a human heart have?", options: ["2", "3", "5", "4"], correctIndex: 3 },
      { question: "What is the powerhouse of the cell?", options: ["Nucleus", "Ribosome", "Mitochondria", "Chloroplast"], correctIndex: 2 },
      { question: "How do plants make their food?", options: ["Transpiration", "Respiration", "Digestion", "Photosynthesis"], correctIndex: 3 },
      { question: "How many bones are in the adult human body?", options: ["186", "226", "206", "196"], correctIndex: 2 },
      { question: "What carries oxygen in blood?", options: ["White blood cells", "Plasma", "Platelets", "Red blood cells"], correctIndex: 3 },
    ],
    "General Science": [
      { question: "Who invented the telephone?", options: ["Thomas Edison", "Nikola Tesla", "Albert Einstein", "Alexander Graham Bell"], correctIndex: 3 },
      { question: "What is the boiling point of water?", options: ["90 degrees C", "110 degrees C", "80 degrees C", "100 degrees C"], correctIndex: 3 },
      { question: "What force keeps us on Earth?", options: ["Friction", "Magnetic force", "Gravity", "Nuclear force"], correctIndex: 2 },
      { question: "Who developed the theory of relativity?", options: ["Isaac Newton", "Stephen Hawking", "Galileo Galilei", "Albert Einstein"], correctIndex: 3 },
      { question: "What does a thermometer measure?", options: ["Pressure", "Temperature", "Weight", "Speed"], correctIndex: 1 },
    ],
  },
  Sports: {
    Cricket: [
      { question: "How many players are in a cricket team?", options: ["9", "10", "12", "11"], correctIndex: 3 },
      { question: "How many balls are bowled in one over?", options: ["4", "5", "8", "6"], correctIndex: 3 },
      { question: "What does LBW stand for in cricket?", options: ["Last Ball Win", "Left Behind Wicket", "Leg Before Wicket", "Lower Bat Width"], correctIndex: 2 },
      { question: "Which country won the first Cricket World Cup in 1975?", options: ["India", "Australia", "England", "West Indies"], correctIndex: 3 },
      { question: "A batsman who scores zero runs is said to be out for a what?", options: ["Red card", "Nil", "Duck", "Zero"], correctIndex: 2 },
    ],
    Football: [
      { question: "How many players are on a football team?", options: ["10", "12", "9", "11"], correctIndex: 3 },
      { question: "How long is a standard football match?", options: ["60 minutes", "80 minutes", "90 minutes", "120 minutes"], correctIndex: 2 },
      { question: "Which country has won the most FIFA World Cups?", options: ["Germany", "Argentina", "France", "Brazil"], correctIndex: 3 },
      { question: "What is it called when a player scores 3 goals in one match?", options: ["Triple", "Hat-trick", "Treble", "Three-peat"], correctIndex: 1 },
      { question: "How often is the FIFA World Cup held?", options: ["Every 2 years", "Every 3 years", "Every 5 years", "Every 4 years"], correctIndex: 3 },
    ],
    Olympics: [
      { question: "How often are the Summer Olympics held?", options: ["Every 3 years", "Every 2 years", "Every 5 years", "Every 4 years"], correctIndex: 3 },
      { question: "How many rings are on the Olympic flag?", options: ["4", "6", "7", "5"], correctIndex: 3 },
      { question: "In which city were the 2020 Summer Olympics held?", options: ["Beijing", "Paris", "Los Angeles", "Tokyo"], correctIndex: 3 },
      { question: "What is the Olympic motto?", options: ["Fair Play Always", "Best in World", "Faster Higher Stronger", "Win at All Costs"], correctIndex: 2 },
      { question: "Which sport uses a shuttlecock?", options: ["Tennis", "Table Tennis", "Squash", "Badminton"], correctIndex: 3 },
    ],
    "General Sports": [
      { question: "In which sport is a puck used?", options: ["Basketball", "Cricket", "Football", "Ice Hockey"], correctIndex: 3 },
      { question: "How many players are on a basketball team on court?", options: ["6", "7", "4", "5"], correctIndex: 3 },
      { question: "Wimbledon is famous for which sport?", options: ["Golf", "Cricket", "Tennis", "Football"], correctIndex: 2 },
      { question: "How many holes are in a standard golf course?", options: ["12", "16", "20", "18"], correctIndex: 3 },
      { question: "In which sport do players use the word love for zero?", options: ["Table Tennis", "Badminton", "Squash", "Tennis"], correctIndex: 3 },
    ],
  },
  "General Knowledge": {
    "World Geography": [
      { question: "What is the capital of Japan?", options: ["Osaka", "Kyoto", "Hiroshima", "Tokyo"], correctIndex: 3 },
      { question: "What is the capital of Australia?", options: ["Sydney", "Perth", "Melbourne", "Canberra"], correctIndex: 3 },
      { question: "What is the largest country in the world by area?", options: ["China", "Canada", "USA", "Russia"], correctIndex: 3 },
      { question: "What is the capital of Brazil?", options: ["Sao Paulo", "Rio de Janeiro", "Salvador", "Brasilia"], correctIndex: 3 },
      { question: "Which river is the longest in the world?", options: ["Amazon", "Yangtze", "Mississippi", "Nile"], correctIndex: 3 },
    ],
    "Famous People": [
      { question: "Who painted the Mona Lisa?", options: ["Picasso", "Leonardo da Vinci", "Van Gogh", "Michelangelo"], correctIndex: 1 },
      { question: "Who wrote Romeo and Juliet?", options: ["William Shakespeare", "Charles Dickens", "Mark Twain", "Jane Austen"], correctIndex: 0 },
      { question: "Who was the first person to walk on the Moon?", options: ["Buzz Aldrin", "Yuri Gagarin", "Neil Armstrong", "John Glenn"], correctIndex: 2 },
      { question: "Who invented the light bulb?", options: ["Alexander Graham Bell", "Nikola Tesla", "Thomas Edison", "Benjamin Franklin"], correctIndex: 2 },
      { question: "Who was the first woman to win a Nobel Prize?", options: ["Mother Teresa", "Marie Curie", "Rosalind Franklin", "Jane Goodall"], correctIndex: 1 },
    ],
    Technology: [
      { question: "What does CPU stand for?", options: ["Computer Processing Unit", "Central Processing Unit", "Central Program Unit", "Control Processing Unit"], correctIndex: 1 },
      { question: "Who founded Microsoft?", options: ["Steve Jobs", "Elon Musk", "Mark Zuckerberg", "Bill Gates"], correctIndex: 3 },
      { question: "What does HTML stand for?", options: ["Hyper Text Markup Language", "Home Tool Markup Language", "High Tech Modern Language", "Hyper Transfer Machine Language"], correctIndex: 0 },
      { question: "In which year was the first iPhone released?", options: ["2005", "2010", "2007", "2008"], correctIndex: 2 },
      { question: "What does WWW stand for?", options: ["World Wide Web", "Wide Web World", "Web World Wide", "World Web Works"], correctIndex: 0 },
    ],
    "Nature & Animals": [
      { question: "What is the largest animal on Earth?", options: ["Elephant", "Giant Squid", "Giraffe", "Blue Whale"], correctIndex: 3 },
      { question: "How many legs does an insect have?", options: ["8", "10", "4", "6"], correctIndex: 3 },
      { question: "What is a group of lions called?", options: ["Pack", "Flock", "Pride", "Herd"], correctIndex: 2 },
      { question: "Which bird is famously known for not being able to fly?", options: ["Eagle", "Parrot", "Penguin", "Sparrow"], correctIndex: 2 },
      { question: "What is the hardest natural substance on Earth?", options: ["Gold", "Quartz", "Iron", "Diamond"], correctIndex: 3 },
    ],
  },
  History: {
    "Ancient History": [
      { question: "Who built the Great Pyramids of Giza?", options: ["Ancient Egyptians", "Greeks", "Romans", "Persians"], correctIndex: 0 },
      { question: "Which civilization built the Colosseum?", options: ["Egyptians", "Romans", "Greeks", "Vikings"], correctIndex: 1 },
      { question: "In which year was the city of Rome traditionally founded?", options: ["753 BC", "500 BC", "1000 BC", "250 BC"], correctIndex: 0 },
      { question: "Who was the first Roman Emperor?", options: ["Julius Caesar", "Augustus", "Nero", "Claudius"], correctIndex: 1 },
      { question: "The ancient Olympic Games originated in which country?", options: ["Italy", "Turkey", "Egypt", "Greece"], correctIndex: 3 },
    ],
    Medieval: [
      { question: "What were the religious wars launched by European Christians called?", options: ["World Wars", "Civil Wars", "Crusades", "Revolutions"], correctIndex: 2 },
      { question: "What did medieval knights wear for protection in battle?", options: ["Uniforms", "Armour", "Robes", "Shields only"], correctIndex: 1 },
      { question: "The Black Death was which type of disease?", options: ["Flu", "Cholera", "Smallpox", "Plague"], correctIndex: 3 },
      { question: "What large fortified structure protected a medieval lord?", options: ["Pyramid", "Temple", "Castle", "Palace"], correctIndex: 2 },
      { question: "Which explorer reached the Americas in 1492?", options: ["Ferdinand Magellan", "Vasco da Gama", "Marco Polo", "Christopher Columbus"], correctIndex: 3 },
    ],
    "Modern History": [
      { question: "In which year did World War II end?", options: ["1945", "1943", "1944", "1946"], correctIndex: 0 },
      { question: "Who was the first President of the United States?", options: ["John Adams", "Abraham Lincoln", "George Washington", "Thomas Jefferson"], correctIndex: 2 },
      { question: "In which year did the Berlin Wall fall?", options: ["1985", "1993", "1991", "1989"], correctIndex: 3 },
      { question: "Which country was the first to land humans on the Moon?", options: ["Russia", "China", "USA", "France"], correctIndex: 2 },
      { question: "What event triggered the start of World War I?", options: ["Bombing of Pearl Harbor", "Invasion of Poland", "Fall of Berlin Wall", "Assassination of Archduke Franz Ferdinand"], correctIndex: 3 },
    ],
    "Indian History": [
      { question: "Who led India's non-violent independence movement?", options: ["Jawaharlal Nehru", "Mahatma Gandhi", "Subhash Chandra Bose", "Bhagat Singh"], correctIndex: 1 },
      { question: "In which year did India gain independence?", options: ["1945", "1950", "1942", "1947"], correctIndex: 3 },
      { question: "Who was India's first Prime Minister?", options: ["Sardar Patel", "Rajendra Prasad", "B.R. Ambedkar", "Jawaharlal Nehru"], correctIndex: 3 },
      { question: "Which empire built the Taj Mahal?", options: ["British", "Maratha", "Mughal", "Portuguese"], correctIndex: 2 },
      { question: "What is the name of India's national anthem?", options: ["Vande Mataram", "Sare Jahan Se Acha", "Jai Hind", "Jana Gana Mana"], correctIndex: 3 },
    ],
  },
};

// ─── Helpers ───────────────────────────────────────────────────────
const VOICE = 'en-IN-NeerjaExpressiveNeural';

function getTimestamp() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())}_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
}

function runEdgeTts(text, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('python', ['-m', 'edge_tts', '--voice', VOICE, '--text', text, '--write-media', outputPath]);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`edge-tts failed: ${stderr}`))));
    proc.on('error', reject);
  });
}

async function getMp3Duration(filePath) {
  const fp = filePath.replace(/\\/g, '/');
  const { stdout } = await execAsync(`python -c "from mutagen.mp3 import MP3; print(MP3(r'${fp}').info.length)"`, { timeout: 10000 });
  return parseFloat(stdout.trim());
}

// ─── Core: generate a video ────────────────────────────────────────
async function generateVideo(question, options, correctIndex, format = '16:9') {
  const ts = getTimestamp();
  const voiceDir = path.join(__dirname, 'public', 'voice');
  const outDir   = path.join(__dirname, 'out');
  fs.mkdirSync(voiceDir, { recursive: true });
  fs.mkdirSync(outDir,   { recursive: true });

  const qAbs = path.join(voiceDir, `q_${ts}.mp3`);
  const oAbs = path.join(voiceDir, `o_${ts}.mp3`);
  const aAbs = path.join(voiceDir, `a_${ts}.mp3`);

  const optText = `A, ${options[0]}. B, ${options[1]}. C, ${options[2]}. D, ${options[3]}.`;
  const ansText = `The answer is ${options[correctIndex]}. You are correct! Amazing! You are a superstar!`;

  console.log(`[${ts}] Generating voice…`);
  await Promise.all([
    runEdgeTts(question, qAbs),
    runEdgeTts(optText,  oAbs),
    runEdgeTts(ansText,  aAbs),
  ]);

  const [qDur, oDur, aDur] = await Promise.all([
    getMp3Duration(qAbs),
    getMp3Duration(oAbs),
    getMp3Duration(aAbs),
  ]);

  const props = {
    question,
    options,
    correctIndex,
    format,
    questionVoice:  `voice/q_${ts}.mp3`,
    optionsVoice:   `voice/o_${ts}.mp3`,
    answerVoice:    `voice/a_${ts}.mp3`,
    questionSeconds: Math.ceil(qDur) + 1,
    optionsSeconds:  Math.ceil(oDur) + 1,
    timerSeconds: 5,
    answerSeconds:   Math.ceil(aDur) + 2,
  };

  const propsFile = path.join(__dirname, `_props_${ts}.json`);
  fs.writeFileSync(propsFile, JSON.stringify(props));

  const videoName = `quiz_${ts}.mp4`;
  const videoPath = path.join(outDir, videoName).replace(/\\/g, '/');
  const propsPath = propsFile.replace(/\\/g, '/');

  const portrait = format === '9:16';
  const vidW = portrait ? 720 : 1280;
  const vidH = portrait ? 1280 : 720;
  const totalFrames = (props.questionSeconds + props.optionsSeconds + props.timerSeconds + props.answerSeconds) * 30;

  console.log(`[${ts}] Rendering video… (format: ${format}, ${vidW}x${vidH}, frames: ${totalFrames})`);
  try {
    await execAsync(
      `npx remotion render QuizVideo "${videoPath}" --props="${propsPath}" --width=${vidW} --height=${vidH} --frames=0-${totalFrames - 1}`,
      { cwd: __dirname, timeout: 600000 }
    );
  } finally {
    try { fs.unlinkSync(propsFile); } catch {}
  }

  console.log(`[${ts}] Done → out/${videoName}`);
  const base = process.env.BACKEND_URL || '';
  return { videoUrl: `${base}/videos/${videoName}`, filename: videoName, question, options, correctIndex };
}

// ─── Helper: flatten all questions ────────────────────────────────
function getAllQuestions() {
  const all = [];
  for (const cat of Object.values(QUESTION_BANK)) {
    for (const sub of Object.values(cat)) {
      all.push(...sub);
    }
  }
  return all;
}

// ─── Routes ────────────────────────────────────────────────────────

// GET /api/categories — returns the category/subcategory tree
app.get('/api/categories', (req, res) => {
  const tree = {};
  for (const [cat, subs] of Object.entries(QUESTION_BANK)) {
    tree[cat] = Object.keys(subs);
  }
  res.json({ success: true, categories: tree });
});

// POST /api/generate-random — optional { category, subcategory } body
app.post('/api/generate-random', async (req, res) => {
  try {
    const { category, subcategory } = req.body || {};
    let pool;

    if (category && subcategory) {
      pool = QUESTION_BANK[category]?.[subcategory];
      if (!pool || pool.length === 0)
        return res.status(400).json({ success: false, error: `No questions found for ${category} → ${subcategory}` });
    } else if (category) {
      const catData = QUESTION_BANK[category];
      if (!catData)
        return res.status(400).json({ success: false, error: `Unknown category: ${category}` });
      pool = Object.values(catData).flat();
    } else {
      pool = getAllQuestions();
    }

    const { format = '16:9' } = req.body || {};
    const q = pool[Math.floor(Math.random() * pool.length)];
    res.json({ success: true, ...(await generateVideo(q.question, q.options, q.correctIndex, format)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/generate-custom — unchanged (single question)
app.post('/api/generate-custom', async (req, res) => {
  try {
    const { question, options, correctIndex, format = '16:9' } = req.body;
    if (!question || !Array.isArray(options) || options.length !== 4 || correctIndex == null)
      return res.status(400).json({ success: false, error: 'Provide question, 4 options, and correctIndex.' });
    res.json({ success: true, ...(await generateVideo(question.trim(), options.map(o => o.trim()), +correctIndex, format)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🎬  Quiz Video Generator  →  http://localhost:${PORT}\n`);
});
