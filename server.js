const express = require('express');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const session = require('express-session');
const MongoStore = require('connect-mongodb-session')(session);
const bcrypt = require('bcrypt');
const stripe = require('stripe')('sk_test_51YourActualStripeSecretKey');
// --- NEW: Added Nodemailer and crypto for email and token generation ---
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const app = express();

app.use(express.json());
app.use(express.static('public'));

console.log('Server starting...');

const mongoURI = process.env.MONGODB_URI || 'mongodb+srv://admin:securepassword123@englishlearningcluster.bhzo4.mongodb.net/english_learning?retryWrites=true&w=majority&appName=EnglishLearningCluster';
const clientOptions = {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
    maxPoolSize: 10
};

// --- NEW: Nodemailer setup with Mailtrap credentials ---
// Replace these with your Mailtrap SMTP details from mailtrap.io
const transporter = nodemailer.createTransport({
    host: 'sandbox.smtp.mailtrap.io',
    port: 587,
    auth: {
        user: process.env.MAILTRAP_USER, // e.g., '1a2b3c4d5e6f7g8h' from Mailtrap
        pass: process.env.MAILTRAP_PASS,  // e.g., '9i8h7g6f5e4d3c2b' from Mailtrap
    }
});

let client;
let db;

async function initializeDB() {
    if (!client) {
        client = new MongoClient(mongoURI, clientOptions);
        try {
            await client.connect();
            console.log('Connected to MongoDB Atlas via MongoClient');
            db = client.db('english_learning');
        } catch (err) {
            console.error('Initial MongoDB connection failed:', err.message);
            throw err;
        }
    }
    return db;
}

async function ensureDBConnection() {
    const maxRetries = 5;
    let attempts = 0;
    while (!db && attempts < maxRetries) {
        attempts++;
        try {
            await initializeDB();
            console.log(`MongoDB connected after ${attempts} attempts`);
            return db;
        } catch (err) {
            console.error(`MongoDB connection attempt ${attempts} failed:`, err.message);
            if (attempts === maxRetries) {
                console.error('Max retries reached, proceeding with fallback');
                return null;
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    return db;
}

const store = new MongoStore({
    uri: mongoURI,
    databaseName: 'english_learning',
    collection: 'sessions'
});

store.on('error', (err) => console.error('Session store error:', err));

app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    store: store,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

function normalizeText(text) {
    return text.toLowerCase().trim().replace(/’/g, "'"); // Normalize curly to straight apostrophe
}

async function updateUserScore(userId, db) {
    const users = db.collection('users');
    const user = await users.findOne({ _id: new ObjectId(userId) });
    if (!user) return;

    const lessons = await db.collection('lessons').find().toArray();
    const quizzes = await db.collection('quizzes').find().toArray();
    const totalTasks = 
        lessons.filter(l => l.homework).length + 
        lessons.filter(l => l.comprehension?.questions).length + 
        lessons.filter(l => l.pronunciation).length + 
        quizzes.length;

    const completedTasks = 
        (user.homeworkScores?.length || 0) +
        (user.comprehensionScores?.length || 0) +
        (user.pronunciationScores?.filter(s => s.correct).length || 0) +
        (user.quizScores?.length || 0);

    const score = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    await users.updateOne({ _id: new ObjectId(userId) }, { $set: { score } });
    console.log(`Updated user score: ${score}% (${completedTasks}/${totalTasks})`);

    for (let i = 0; i < (user.homeworkScores?.length || 0); i++) {
        if (!user.homeworkScores[i].title || user.homeworkScores[i].title === 'Untitled Lesson') {
            const lesson = await db.collection('lessons').findOne({ _id: new ObjectId(user.homeworkScores[i].lessonId) });
            user.homeworkScores[i].title = lesson ? lesson.title : 'Unknown Lesson';
        }
    }
    for (let i = 0; i < (user.comprehensionScores?.length || 0); i++) {
        if (!user.comprehensionScores[i].title || user.comprehensionScores[i].title === 'Untitled Lesson') {
            const lesson = await db.collection('lessons').findOne({ _id: new ObjectId(user.comprehensionScores[i].lessonId) });
            user.comprehensionScores[i].title = lesson ? lesson.title : 'Unknown Lesson';
        }
    }
    for (let i = 0; i < (user.quizScores?.length || 0); i++) {
        if (!user.quizScores[i].title || user.quizScores[i].title === 'Untitled Quiz') {
            const quiz = await db.collection('quizzes').findOne({ _id: new ObjectId(user.quizScores[i].quizId) });
            user.quizScores[i].title = quiz ? quiz.title : 'Unknown Quiz';
        }
    }
    await users.updateOne({ _id: new ObjectId(userId) }, { 
        $set: { 
            homeworkScores: user.homeworkScores || [], 
            comprehensionScores: user.comprehensionScores || [], 
            quizScores: user.quizScores || [] 
        } 
    });
    console.log('Updated titles for user scores');
}

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    console.log('Login attempt:', { email });
    try {
        const db = await ensureDBConnection();
        if (!db) {
            console.log('DB not connected, using fallback login');
            req.session.userId = 'fallback-id';
            return res.status(200).send();
        }
        const users = db.collection('users');
        const user = await users.findOne({ email });
        if (!user) {
            console.log('User not found:', email);
            return res.status(401).send('Invalid credentials');
        }
        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            console.log('Password mismatch for:', email);
            return res.status(401).send('Invalid credentials');
        }
        // --- NEW: Check if user is verified before allowing login ---
        if (!user.isVerified) {
            console.log('User not verified:', email);
            return res.status(403).send('Please verify your email first.');
        }
        req.session.userId = user._id.toString();
        console.log('Login successful:', email, 'Session ID:', req.session.userId);
        res.status(200).send();
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ error: 'Server error - DB may be unavailable', details: err.message });
    }
});

// --- NEW: Updated signup endpoint with email confirmation ---
app.post('/api/signup', async (req, res) => {
    const { email, password, name } = req.body;
    console.log('Signup attempt:', { email });
    try {
        const db = await ensureDBConnection();
        if (!db) return res.status(500).json({ error: 'Database unavailable, signup failed' });
        const users = db.collection('users');
        const existingUser = await users.findOne({ email });
        if (existingUser) {
            console.log('Email already in use:', email);
            return res.status(400).send('Email already in use');
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        // --- NEW: Generate a unique verification token ---
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const result = await users.insertOne({ 
            email, 
            password: hashedPassword, 
            name, 
            score: 0, 
            homeworkScores: [], 
            pronunciationScores: [], 
            comprehensionScores: [], 
            quizScores: [], 
            referencesVisited: [], 
            achievements: [], 
            admin: false,
            verificationToken,  // Store token
            isVerified: false   // Default to unverified
        });
        console.log('Signup successful:', email, 'User ID:', result.insertedId);

        // --- NEW: Send verification email ---
        const confirmationUrl = `https://english-learning-website-olive.vercel.app/api/verify?token=${verificationToken}`;
        const mailOptions = {
            from: 'no-reply@englishlearning.com',
            to: email,
            subject: 'Welcome to Thuan’s English Learning! Confirm Your Email',
            html: `
                <h2>Hello ${name || 'Learner'}!</h2>
                <p>Thanks for joining Thuan’s English Learning Platform!</p>
                <p>Click <a href="${confirmationUrl}">here</a> to verify your email and start learning.</p>
                <p>Keep this email—use it to find us anytime at <a href="https://english-learning-website-olive.vercel.app">our site</a>!</p>
                <p>Cheers,<br>Thuan & Team</p>
            `
        };
        await transporter.sendMail(mailOptions);
        console.log('Verification email sent to:', email);

        res.status(201).json({ message: 'Signup successful! Check your email to verify.' });
    } catch (err) {
        console.error('Signup error:', err.message);
        res.status(500).json({ error: 'Server error - Signup failed: ' + err.message });
    }
});

// --- NEW: Verification endpoint to confirm email ---
app.get('/api/verify', async (req, res) => {
    const { token } = req.query;
    console.log('Verification attempt with token:', token);
    try {
        const db = await ensureDBConnection();
        if (!db) return res.status(500).send('Database unavailable');
        const users = db.collection('users');
        const user = await users.findOne({ verificationToken: token });
        if (!user) {
            console.log('Invalid or expired token:', token);
            return res.status(400).send('Invalid or expired token.');
        }
        await users.updateOne(
            { _id: new ObjectId(user._id) },
            { $set: { isVerified: true }, $unset: { verificationToken: "" } }
        );
        console.log('User verified:', user.email);
        res.redirect('/dashboard.html'); // Redirect to dashboard after verification
    } catch (err) {
        console.error('Verification error:', err.message);
        res.status(500).send('Verification failed.');
    }
});

app.get('/api/user-data', async (req, res) => {
    console.log('User data request, session:', req.session);
    if (!req.session.userId) {
        console.log('No session userId');
        return res.status(401).send('Not logged in');
    }
    try {
        const db = await ensureDBConnection();
        if (!db) return res.json({ name: 'Fallback User', score: 49, achievements: [{ name: 'Pronunciation Pro', dateEarned: new Date() }] });
        const users = db.collection('users');
        const lessons = await db.collection('lessons').find().toArray();
        const quizzes = await db.collection('quizzes').find().toArray();
        await updateUserScore(req.session.userId, db);
        const user = await users.findOne({ _id: new ObjectId(req.session.userId) });
        if (!user) {
            console.log('User not found:', req.session.userId);
            return res.status(404).send('User not found');
        }
        const data = {
            name: user.name || 'Unknown User',
            score: user.score || 0,
            homeworkScores: user.homeworkScores || [],
            pronunciationScores: user.pronunciationScores || [],
            comprehensionScores: user.comprehensionScores || [],
            quizScores: user.quizScores || [],
            referencesVisited: user.referencesVisited || [],
            achievements: user.achievements || [],
            lessons: lessons.map(l => ({ homework: !!l.homework, comprehension: !!l.comprehension?.questions, pronunciation: !!l.pronunciation })),
            quizzes: quizzes.map(q => ({ id: q._id }))
        };
        console.log('User data sent:', data);
        res.json(data);
    } catch (err) {
        console.error('User data error:', err.message);
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
    }
});

app.get('/api/lessons', async (req, res) => {
    console.log('Lessons request');
    try {
        const db = await ensureDBConnection();
        if (!db) return res.json([{ _id: '1', title: 'Sample Lesson 1', content: 'This is a sample lesson.', level: 'B1', createdAt: new Date() }]);
        const lessons = await db.collection('lessons').find().sort({ createdAt: -1 }).toArray();
        console.log('Lessons sent:', lessons.length);
        res.json(lessons);
    } catch (err) {
        console.error('Lessons error:', err.message);
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
    }
});

app.get('/api/references', async (req, res) => {
    console.log('References request');
    try {
        const db = await ensureDBConnection();
        if (!db) return res.json([{ _id: '1', title: 'Sample Reference', url: 'https://example.com', description: 'A sample resource' }]);
        const references = await db.collection('references').find().toArray();
        console.log('References sent:', references.length);
        res.json(references);
    } catch (err) {
        console.error('References error:', err.message);
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
    }
});

app.get('/api/blogs', async (req, res) => {
    console.log('Blogs request');
    try {
        const db = await ensureDBConnection();
        if (!db) return res.json([{ _id: '1', title: 'Sample Blog', content: 'This is a sample blog post.', createdAt: new Date() }]);
        const blogs = await db.collection('blogs').find().sort({ createdAt: -1 }).toArray();
        console.log('Blogs sent:', blogs.length);
        res.json(blogs);
    } catch (err) {
        console.error('Blogs error:', err.message);
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
    }
});

app.get('/api/quizzes', async (req, res) => {
    console.log('Quizzes request');
    try {
        const db = await ensureDBConnection();
        if (!db) return res.json([{ _id: '1', title: 'Sample Quiz', type: 'fill-in', questions: [{ prompt: 'What is 2+2?', correctAnswer: '4' }], timeLimit: 60, level: 'B1', createdAt: new Date() }]);
        const quizzes = await db.collection('quizzes').find().sort({ createdAt: -1 }).toArray();
        console.log('Quizzes sent:', quizzes.length);
        res.json(quizzes);
    } catch (err) {
        console.error('Quizzes error:', err.message);
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    console.log('Leaderboard request');
    try {
        const db = await ensureDBConnection();
        if (!db) return res.json([{ name: 'Fallback User', score: 49 }]);
        const users = await db.collection('users').find().toArray();
        for (const user of users) {
            await updateUserScore(user._id.toString(), db);
        }
        const leaderboard = await db.collection('users')
            .find({}, { projection: { name: 1, score: 1 } })
            .sort({ score: -1 })
            .limit(10)
            .toArray();
        console.log('Leaderboard sent:', leaderboard);
        res.json(leaderboard);
    } catch (err) {
        console.error('Leaderboard error:', err.message);
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
    }
});

app.post('/api/comprehension', async (req, res) => {
    console.log('Comprehension request:', req.body);
    if (!req.session.userId) {
        console.log('No session userId');
        return res.status(401).send('Not logged in');
    }
    const { lessonId, answers } = req.body;
    try {
        const db = await ensureDBConnection();
        if (!db) return res.status(500).json({ error: 'Database unavailable' });
        const lessons = db.collection('lessons');
        const lesson = await lessons.findOne({ _id: new ObjectId(lessonId) });
        if (!lesson || !lesson.comprehension || !lesson.comprehension.questions) {
            console.log('Lesson or comprehension questions not found:', lessonId);
            return res.status(404).send('Lesson or comprehension questions not found');
        }
        let score = 0;
        const feedback = lesson.comprehension.questions.map((q, i) => {
            const isCorrect = answers[i] === q.correctAnswer;
            if (isCorrect) score++;
            return { question: q.question, correct: isCorrect, correctAnswer: q.correctAnswer };
        });
        const comprehensionScore = Math.round((score / lesson.comprehension.questions.length) * 100);

        const users = db.collection('users');
        const user = await users.findOne({ _id: new ObjectId(req.session.userId) });
        if (!user.comprehensionScores) user.comprehensionScores = [];
        const existingScoreIndex = user.comprehensionScores.findIndex(s => s.lessonId.toString() === lessonId);
        if (existingScoreIndex !== -1) {
            user.comprehensionScores[existingScoreIndex].score = comprehensionScore;
            user.comprehensionScores[existingScoreIndex].title = lesson.title;
        } else {
            user.comprehensionScores.push({ lessonId, score: comprehensionScore, title: lesson.title });
        }
        await users.updateOne({ _id: new ObjectId(req.session.userId) }, { $set: { comprehensionScores: user.comprehensionScores } });
        await updateUserScore(req.session.userId, db);
        console.log('Comprehension processed:', { lessonId, comprehensionScore });
        res.json({ score: score, total: lesson.comprehension.questions.length, feedback });
    } catch (err) {
        console.error('Comprehension error:', err.message);
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
    }
});

app.post('/api/homework', async (req, res) => {
    console.log('Homework request:', req.body);
    if (!req.session.userId) {
        console.log('No session userId');
        return res.status(401).send('Not logged in');
    }
    const { lessonId, answers } = req.body;
    try {
        const db = await ensureDBConnection();
        if (!db) return res.status(500).json({ error: 'Database unavailable' });
        const lessons = db.collection('lessons');
        const lesson = await lessons.findOne({ _id: new ObjectId(lessonId) });
        if (!lesson || !lesson.homework || lesson.homework.length === 0) {
            console.log('Lesson or homework not found:', lessonId);
            return res.status(404).send('Lesson or homework not found');
        }
        let score = 0;
        const feedback = lesson.homework.map((q, i) => {
            const normalizedAnswer = normalizeText(answers[i]);
            const normalizedCorrect = normalizeText(q.correctAnswer);
            const isCorrect = normalizedAnswer === normalizedCorrect;
            if (isCorrect) score++;
            return { question: q.question, correct: isCorrect, correctAnswer: q.correctAnswer, userAnswer: answers[i] };
        });
        const homeworkScore = Math.round((score / lesson.homework.length) * 100);

        const users = db.collection('users');
        const user = await users.findOne({ _id: new ObjectId(req.session.userId) });
        if (!user.homeworkScores) user.homeworkScores = [];
        const existingScoreIndex = user.homeworkScores.findIndex(s => s.lessonId.toString() === lessonId);
        if (existingScoreIndex !== -1) {
            user.homeworkScores[existingScoreIndex].score = homeworkScore;
            user.homeworkScores[existingScoreIndex].title = lesson.title;
        } else {
            user.homeworkScores.push({ lessonId, score: homeworkScore, title: lesson.title });
        }
        await users.updateOne({ _id: new ObjectId(req.session.userId) }, { $set: { homeworkScores: user.homeworkScores } });
        await updateUserScore(req.session.userId, db);
        console.log('Homework processed:', { lessonId, homeworkScore });
        res.json({ score: score, total: lesson.homework.length, feedback });
    } catch (err) {
        console.error('Homework error:', err.message);
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
    }
});

app.post('/api/submit-quiz', async (req, res) => {
    console.log('Quiz submission request:', req.body);
    if (!req.session.userId) {
        console.log('No session userId');
        return res.status(401).send('Not logged in');
    }
    const { quizId, answers } = req.body;
    try {
        const db = await ensureDBConnection();
        if (!db) return res.status(500).json({ error: 'Database unavailable' });
        const quizzes = db.collection('quizzes');
        const quiz = await quizzes.findOne({ _id: new ObjectId(quizId) });
        if (!quiz || !quiz.questions) {
            console.log('Quiz or questions not found:', quizId);
            return res.status(404).send('Quiz or questions not found');
        }
        let score = 0;
        const feedback = quiz.questions.map((q, i) => {
            const isCorrect = answers[i] === q.correctAnswer;
            if (isCorrect) score++;
            return { prompt: q.prompt, correct: isCorrect, correctAnswer: q.correctAnswer };
        });
        const quizScore = Math.round((score / quiz.questions.length) * 100);

        const users = db.collection('users');
        const user = await users.findOne({ _id: new ObjectId(req.session.userId) });
        if (!user.quizScores) user.quizScores = [];
        const existingScoreIndex = user.quizScores.findIndex(s => s.quizId.toString() === quizId);
        if (existingScoreIndex !== -1) {
            user.quizScores[existingScoreIndex].score = quizScore;
            user.quizScores[existingScoreIndex].title = quiz.title;
        } else {
            user.quizScores.push({ quizId, score: quizScore, title: quiz.title });
        }
        await users.updateOne({ _id: new ObjectId(req.session.userId) }, { $set: { quizScores: user.quizScores } });
        await updateUserScore(req.session.userId, db);
        console.log('Quiz processed:', { quizId, quizScore });
        res.json({ score: score, total: quiz.questions.length, feedback });
    } catch (err) {
        console.error('Quiz submission error:', err.message);
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
    }
});

app.post('/api/pronunciation', async (req, res) => {
    console.log('Pronunciation request:', req.body);
    if (!req.session.userId) {
        console.log('No session userId');
        return res.status(401).send('Not logged in');
    }
    const { lessonId, phrase, isCorrect } = req.body;
    try {
        const db = await ensureDBConnection();
        if (!db) return res.status(500).json({ error: 'Database unavailable' });
        const lessons = db.collection('lessons');
        const lesson = await lessons.findOne({ _id: new ObjectId(lessonId) });
        if (!lesson || !lesson.pronunciation || !lesson.pronunciation.some(p => p.phrase === phrase)) {
            console.log('Lesson or phrase not found:', { lessonId, phrase });
            return res.status(404).send('Lesson or phrase not found');
        }
        const users = db.collection('users');
        const user = await users.findOne({ _id: new ObjectId(req.session.userId) });
        if (!user.pronunciationScores) user.pronunciationScores = [];
        const existingScoreIndex = user.pronunciationScores.findIndex(s => s.lessonId.toString() === lessonId && s.phrase === phrase);
        if (existingScoreIndex !== -1) {
            user.pronunciationScores[existingScoreIndex].correct = isCorrect;
            user.pronunciationScores[existingScoreIndex].attempts += 1;
        } else {
            user.pronunciationScores.push({ lessonId, phrase, correct: isCorrect, attempts: 1 });
        }
        await users.updateOne({ _id: new ObjectId(req.session.userId) }, { $set: { pronunciationScores: user.pronunciationScores } });
        await updateUserScore(req.session.userId, db);
        console.log('Pronunciation saved:', { lessonId, phrase, isCorrect });
        res.send('Pronunciation recorded');
    } catch (err) {
        console.error('Pronunciation error:', err.message);
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
    }
});

app.get('/api/logout', (req, res) => {
    console.log('Logout attempt, session:', req.session);
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err.message);
            return res.status(500).json({ error: 'Logout failed' });
        }
        console.log('Logout successful');
        res.redirect('/index.html');
    });
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));