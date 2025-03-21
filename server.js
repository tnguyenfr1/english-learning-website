const express = require('express');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const session = require('express-session');
const MongoStore = require('connect-mongodb-session')(session);
const bcrypt = require('bcrypt');
const stripe = require('stripe')('sk_test_51YourActualStripeSecretKey'); // Replace with your key
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();

app.use(express.json());
app.use(express.static('public'));

console.log('Server starting...');

const mongoURI = process.env.MONGODB_URI || 'mongodb+srv://admin:securepassword123@englishlearningcluster.bhzo4.mongodb.net/english_learning?retryWrites=true&w=majority&appName=EnglishLearningCluster';
const clientOptions = {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
    maxPoolSize: 10,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 45000
};

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
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
                console.error('Max retries reached, returning null');
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
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    store: store,
    cookie: { 
        maxAge: 1000 * 60 * 60 * 24,
        secure: process.env.NODE_ENV === 'production', // true on Vercel
        httpOnly: true,
        sameSite: 'lax' // Add this for cross-origin requests
    }
}));

const requireLogin = (req, res, next) => {
    if (!req.session.userId) {
        console.log('No session userId - access denied');
        return res.status(401).json({ error: 'Not logged in' });
    }
    next();
};

app.get('/dashboard.html', requireLogin, (req, res) => {
    res.sendFile(__dirname + '/public/dashboard.html');
});

function normalizeText(text) {
    return text.toLowerCase().trim().replace(/’/g, "'");
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

    for (const scoreType of ['homeworkScores', 'comprehensionScores', 'quizScores']) {
        if (user[scoreType]) {
            for (let i = 0; i < user[scoreType].length; i++) {
                if (!user[scoreType][i].title || user[scoreType][i].title === 'Untitled Lesson' || user[scoreType][i].title === 'Untitled Quiz') {
                    const idField = scoreType === 'quizScores' ? 'quizId' : 'lessonId';
                    const collection = scoreType === 'quizScores' ? 'quizzes' : 'lessons';
                    const item = await db.collection(collection).findOne({ _id: new ObjectId(user[scoreType][i][idField]) });
                    user[scoreType][i].title = item ? item.title : `Unknown ${collection.slice(0, -1)}`;
                }
            }
            await users.updateOne({ _id: new ObjectId(userId) }, { $set: { [scoreType]: user[scoreType] } });
        }
    }
    console.log('Updated titles for user scores');
}

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    console.log('Login attempt:', { email });
    try {
        const db = await ensureDBConnection();
        if (!db) throw new Error('Database unavailable');
        const users = db.collection('users');
        const user = await users.findOne({ email });
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) return res.status(401).json({ error: 'Invalid credentials' });
        if (!user.isVerified) return res.status(403).json({ error: 'Please verify your email first' });

        req.session.userId = user._id.toString();
        console.log('Set session ID:', req.session.userId);

        // Force session save and verify
        await new Promise((resolve, reject) => {
            req.session.save((err) => {
                if (err) {
                    console.error('Session save failed:', err.message);
                    reject(err);
                } else {
                    console.log('Session saved successfully');
                    resolve();
                }
            });
        });

        // Verify session in store
        const sessionDoc = await db.collection('sessions').findOne({ _id: req.sessionID });
        console.log('Session in DB:', sessionDoc ? 'Found' : 'Not found');

        res.status(200).json({ message: 'Login successful', userId: req.session.userId });
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

app.post('/api/signup', async (req, res) => {
    const { email, password, name } = req.body;
    console.log('Signup attempt:', { email });
    try {
        const db = await ensureDBConnection();
        if (!db) return res.status(500).json({ error: 'Database unavailable' });
        const users = db.collection('users');
        const existingUser = await users.findOne({ email });
        if (existingUser) {
            console.log('Email already in use:', email);
            return res.status(400).json({ error: 'Email already in use' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
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
            writingScores: [],
            referencesVisited: [], 
            achievements: [], 
            admin: false,
            verificationToken,
            isVerified: false
        });
        console.log('Signup successful:', email, 'User ID:', result.insertedId);

        const confirmationUrl = `${process.env.BASE_URL || 'https://english-learning-website-olive.vercel.app'}/api/verify?token=${verificationToken}`;
        const mailOptions = {
            from: 'no-reply@englishlearning.com',
            to: email,
            subject: 'Welcome to Thuan’s English Learning! Confirm Your Email',
            html: `
                <div style="font-family: 'SF Pro Display', -apple-system, sans-serif; background: #1d1d1e; color: #fff; padding: 40px; max-width: 600px; margin: 0 auto; border-radius: 18px;">
                    <h2 style="font-size: 28px; font-weight: 700; color: #fff; text-align: center;">Hello ${name || 'Learner'}!</h2>
                    <p style="font-size: 18px; line-height: 1.5; color: #d1d1d1; text-align: center;">
                        Welcome to Thuan’s English Learning Platform! We’re excited to help you master English.
                    </p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${confirmationUrl}" style="background: #0071e3; color: #fff; padding: 12px 24px; text-decoration: none; font-size: 17px; font-weight: 700; border-radius: 10px; display: inline-block;">Verify Your Email</a>
                    </div>
                    <p style="font-size: 14px; color: #d1d1d1; text-align: center;">
                        Keep this email—visit us anytime at <a href="${process.env.BASE_URL || 'https://english-learning-website-olive.vercel.app'}" style="color: #2997ff;">our site</a>!
                    </p>
                    <p style="font-size: 14px; color: #d1d1d1; text-align: center;">Cheers,<br>Thuan & Team</p>
                </div>
            `
        };
        await transporter.sendMail(mailOptions);
        console.log('Verification email sent to:', email);

        res.status(201).json({ message: 'Signup successful! Check your email to verify.' });
    } catch (err) {
        console.error('Signup error:', err.message);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

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
        res.redirect('/dashboard.html');
    } catch (err) {
        console.error('Verification error:', err.message);
        res.status(500).send('Verification failed: ' + err.message);
    }
});

app.post('/api/reset-password', async (req, res) => {
    const { email } = req.body;
    console.log('Password reset request for:', email);
    try {
        const db = await ensureDBConnection();
        if (!db) return res.status(500).json({ error: 'Database unavailable' });
        const users = db.collection('users');
        const user = await users.findOne({ email });
        if (!user) return res.status(404).json({ error: 'Email not found.' });

        const resetToken = crypto.randomBytes(32).toString('hex');
        await users.updateOne({ email }, { $set: { resetToken } });

        const resetUrl = `${process.env.BASE_URL || 'https://english-learning-website-olive.vercel.app'}/api/reset-password?token=${resetToken}`;
        const mailOptions = {
            from: 'no-reply@englishlearning.com',
            to: email,
            subject: 'Reset Your Password - Learn English with Thuan',
            html: `
                <div style="font-family: 'SF Pro Display', -apple-system, sans-serif; background: #1d1d1e; color: #fff; padding: 40px; max-width: 600px; margin: 0 auto; border-radius: 18px;">
                    <h2 style="font-size: 28px; font-weight: 700; color: #fff; text-align: center;">Password Reset</h2>
                    <p style="font-size: 18px; line-height: 1.5; color: #d1d1d1; text-align: center;">
                        Click below to reset your password for Thuan’s English Learning Platform.
                    </p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${resetUrl}" style="background: #0071e3; color: #fff; padding: 12px 24px; text-decoration: none; font-size: 17px; font-weight: 700; border-radius: 10px; display: inline-block;">Reset Password</a>
                    </div>
                    <p style="font-size: 14px; color: #d1d1d1; text-align: center;">If you didn’t request this, ignore this email.</p>
                </div>
            `
        };
        await transporter.sendMail(mailOptions);
        console.log('Reset email sent to:', email);
        res.json({ message: 'Check your email for a password reset link.' });
    } catch (err) {
        console.error('Reset password error:', err.message);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

app.get('/api/reset-password', (req, res) => {
    const { token } = req.query;
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Reset Password</title>
            <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=SF+Pro+Display:wght@400;700&display=swap">
            <style>
                body { font-family: 'SF Pro Display', sans-serif; background: #1d1d1e; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
                .reset-form { background: #2c2c2e; padding: 30px; border-radius: 18px; max-width: 380px; width: 100%; }
                h2 { font-size: 28px; font-weight: 700; text-align: center; margin: 0 0 20px; }
                label { display: block; font-size: 14px; color: #d1d1d1; margin-bottom: 8px; }
                input { width: 100%; padding: 12px; margin-bottom: 20px; border: 1px solid #434345; border-radius: 8px; background: #1d1d1e; color: #fff; font-size: 17px; box-sizing: border-box; }
                button { width: 100%; background: #0071e3; color: #fff; border: none; padding: 12px; font-size: 17px; font-weight: 700; border-radius: 10px; cursor: pointer; }
                button:hover { background: #005bb5; }
            </style>
        </head>
        <body>
            <form class="reset-form" id="resetForm">
                <h2>Reset Password</h2>
                <label for="password">New Password</label>
                <input type="password" id="password" required>
                <button type="submit">Reset</button>
            </form>
            <script>
                document.getElementById('resetForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const password = document.getElementById('password').value;
                    const token = new URLSearchParams(window.location.search).get('token');
                    const response = await fetch('/api/reset-password-submit', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ token, password })
                    });
                    const result = await response.json();
                    alert(result.message || result.error);
                    if (response.ok) window.location.href = '/';
                });
            </script>
        </body>
        </html>
    `);
});

app.post('/api/reset-password-submit', async (req, res) => {
    const { token, password } = req.body;
    console.log('Password reset submission for token:', token);
    try {
        const db = await ensureDBConnection();
        if (!db) return res.status(500).json({ error: 'Database unavailable' });
        const users = db.collection('users');
        const user = await users.findOne({ resetToken: token });
        if (!user) return res.status(400).json({ error: 'Invalid or expired token.' });

        const hashedPassword = await bcrypt.hash(password, 10);
        await users.updateOne(
            { _id: new ObjectId(user._id) },
            { $set: { password: hashedPassword }, $unset: { resetToken: "" } }
        );
        console.log('Password reset successful for:', user.email);
        res.json({ message: 'Password reset successful! Please log in.' });
    } catch (err) {
        console.error('Reset password submit error:', err.message);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// User Data and Progress
app.get('/api/user-check', async (req, res) => {
    if (req.session.userId) {
        const db = await ensureDBConnection();
        if (!db) return res.json({ loggedIn: true, name: 'Fallback User' });
        const user = await db.collection('users').findOne({ _id: new ObjectId(req.session.userId) });
        res.json({ loggedIn: true, name: user?.name || 'Unknown User' });
    } else {
        res.json({ loggedIn: false });
    }
});

app.get('/api/user-progress', requireLogin, async (req, res) => {
    try {
        const db = await ensureDBConnection();
        if (!db) throw new Error('Database connection failed');
        const user = await db.collection('users').findOne({ _id: new ObjectId(req.session.userId) });
        const progress = [];
        if (user.writingScores) {
            progress.push(...user.writingScores.map(s => ({
                activity: 'Writing',
                score: s.score,
                cefr: s.cefr,
                timestamp: s.timestamp instanceof Date ? s.timestamp : new Date(s.timestamp || Date.now())
            })));
        }
        if (user.homeworkScores) {
            progress.push(...user.homeworkScores.map(s => ({
                activity: `Homework (${s.title || 'Lesson ' + s.lessonId})`,
                score: s.total ? Math.round((s.score / s.total) * 100) : 0,
                cefr: null,
                timestamp: s.timestamp instanceof Date ? s.timestamp : new Date(s.timestamp || Date.now())
            })));
        }
        if (user.pronunciationScores) {
            progress.push(...user.pronunciationScores.map(s => ({
                activity: `Pronunciation (Lesson ${s.lessonId})`,
                score: s.isCorrect ? 100 : 0,
                cefr: null,
                timestamp: s.timestamp instanceof Date ? s.timestamp : new Date(s.timestamp || Date.now())
            })));
        }
        if (user.quizScores) {
            progress.push(...user.quizScores.map(s => ({
                activity: `Quiz (${s.title || 'Quiz ' + s.quizId})`,
                score: s.score,
                cefr: null,
                timestamp: s.timestamp instanceof Date ? s.timestamp : new Date(s.timestamp || Date.now())
            })));
        }
        console.log('Returning progress:', progress.length, 'entries');
        res.json(progress.sort((a, b) => b.timestamp - a.timestamp));
    } catch (error) {
        console.error('Progress error:', error.message, error.stack);
        res.status(500).json({ error: 'Failed to fetch progress: ' + error.message });
    }
});

// Public Endpoints
app.get('/api/lessons', async (req, res) => {
    try {
        console.time('Fetch Lessons');
        const db = await ensureDBConnection();
        if (!db) return res.json([]); // Empty array fallback
        const lessons = await db.collection('lessons').find({}).toArray();
        console.log('Lessons retrieved:', lessons.length);
        console.timeEnd('Fetch Lessons');
        res.json(lessons);
    } catch (error) {
        console.error('Lessons endpoint error:', {
            message: error.message,
            stack: error.stack,
            request: req.session.userId ? 'Logged in' : 'Not logged in'
        });
        res.status(500).json({ error: 'Failed to fetch lessons: ' + error.message });
    }
});

app.get('/api/references', async (req, res) => {
    try {
        const db = await ensureDBConnection();
        if (!db) {
            console.error('References: DB unavailable');
            return res.status(500).json({ error: 'Database unavailable' });
        }
        const references = await db.collection('references').find({}).toArray();
        res.json(references);
    } catch (err) {
        console.error('References error:', err.message);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

app.get('/api/blogs', async (req, res) => {
    try {
        const db = await ensureDBConnection();
        if (!db) return res.json([]);
        const blogs = await db.collection('blogs').find().sort({ createdAt: -1 }).toArray();
        console.log('Blogs sent:', blogs.length);
        res.json(blogs);
    } catch (err) {
        console.error('Blogs error:', err.message);
        res.status(500).json({ error: 'Failed to fetch blogs: ' + err.message });
    }
});

app.get('/api/quizzes', async (req, res) => {
    try {
        const db = await ensureDBConnection();
        if (!db) return res.json([]);
        const quizzes = await db.collection('quizzes').find().sort({ createdAt: -1 }).toArray();
        console.log('Quizzes sent:', quizzes.length);
        res.json(quizzes);
    } catch (err) {
        console.error('Quizzes error:', err.message);
        res.status(500).json({ error: 'Failed to fetch quizzes: ' + err.message });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const db = await ensureDBConnection();
        if (!db) return res.json([]);
        const users = await db.collection('users').find().toArray();
        for (const user of users) {
            await updateUserScore(user._id.toString(), db);
        }
        const leaderboard = await db.collection('users')
            .find({}, { projection: { name: 1, score: 1 } })
            .sort({ score: -1 })
            .limit(10)
            .toArray();
        console.log('Leaderboard sent:', leaderboard.length);
        res.json(leaderboard);
    } catch (err) {
        console.error('Leaderboard error:', err.message);
        res.status(500).json({ error: 'Failed to fetch leaderboard: ' + err.message });
    }
});

// Activity Submission Endpoints
app.post('/api/comprehension', async (req, res) => {
    const { lessonId, answers } = req.body;
    try {
        const db = await ensureDBConnection();
        if (!db) return res.status(500).json({ error: 'Database unavailable' });
        const lesson = await db.collection('lessons').findOne({ _id: new ObjectId(lessonId) });
        if (!lesson || !lesson.comprehension?.questions) {
            return res.status(404).json({ error: 'Lesson or comprehension questions not found' });
        }
        let score = 0;
        const feedback = lesson.comprehension.questions.map((q, i) => {
            const isCorrect = answers[i] === q.correctAnswer;
            if (isCorrect) score++;
            return { question: q.question, correct: isCorrect, correctAnswer: q.correctAnswer };
        });

        if (req.session.userId) {
            const users = db.collection('users');
            const user = await users.findOne({ _id: new ObjectId(req.session.userId) });
            if (!user.comprehensionScores) user.comprehensionScores = [];
            const existingScoreIndex = user.comprehensionScores.findIndex(s => s.lessonId.toString() === lessonId);
            if (existingScoreIndex !== -1) {
                user.comprehensionScores[existingScoreIndex] = { lessonId, score, total: lesson.comprehension.questions.length, title: lesson.title, timestamp: new Date() };
            } else {
                user.comprehensionScores.push({ lessonId, score, total: lesson.comprehension.questions.length, title: lesson.title, timestamp: new Date() });
            }
            await users.updateOne({ _id: new ObjectId(req.session.userId) }, { $set: { comprehensionScores: user.comprehensionScores } });
            await updateUserScore(req.session.userId, db);
            console.log('Comprehension saved for user:', req.session.userId);
        }
        res.json({ score, total: lesson.comprehension.questions.length, feedback });
    } catch (err) {
        console.error('Comprehension error:', err.message);
        res.status(500).json({ error: 'Failed to process comprehension: ' + err.message });
    }
});

app.post('/api/homework', async (req, res) => {
    const { lessonId, answers } = req.body;
    try {
        const db = await ensureDBConnection();
        if (!db) return res.status(500).json({ error: 'Database unavailable' });
        const lesson = await db.collection('lessons').findOne({ _id: new ObjectId(lessonId) });
        if (!lesson || !lesson.homework) return res.status(404).json({ error: 'Lesson or homework not found' });

        const feedback = lesson.homework.map((q, i) => ({
            question: q.question,
            correct: q.type === 'fill-in' ? normalizeText(answers[i]) === normalizeText(q.correctAnswer) : answers[i] === q.correctAnswer,
            correctAnswer: q.correctAnswer
        }));
        const score = feedback.filter(f => f.correct).length;
        const total = lesson.homework.length;

        if (req.session.userId) {
            await db.collection('users').updateOne(
                { _id: new ObjectId(req.session.userId) },
                { $push: { homeworkScores: { lessonId, score, total, title: lesson.title, timestamp: new Date() } } }
            );
            await updateUserScore(req.session.userId, db);
            console.log('Homework saved for user:', req.session.userId);
        }
        res.json({ score, total, feedback });
    } catch (err) {
        console.error('Homework error:', err.message);
        res.status(500).json({ error: 'Failed to process homework: ' + err.message });
    }
});

app.post('/api/submit-quiz', async (req, res) => {
    const { quizId, answers } = req.body;
    try {
        const db = await ensureDBConnection();
        if (!db) return res.status(500).json({ error: 'Database unavailable' });
        const quiz = await db.collection('quizzes').findOne({ _id: new ObjectId(quizId) });
        if (!quiz || !quiz.questions) return res.status(404).json({ error: 'Quiz or questions not found' });

        let score = 0;
        const feedback = quiz.questions.map((q, i) => {
            const isCorrect = normalizeText(answers[i]) === normalizeText(q.correctAnswer);
            if (isCorrect) score++;
            return { prompt: q.prompt, correct: isCorrect, correctAnswer: q.correctAnswer };
        });

        if (req.session.userId) {
            const users = db.collection('users');
            const user = await users.findOne({ _id: new ObjectId(req.session.userId) });
            if (!user.quizScores) user.quizScores = [];
            const existingScoreIndex = user.quizScores.findIndex(s => s.quizId.toString() === quizId);
            if (existingScoreIndex !== -1) {
                user.quizScores[existingScoreIndex] = { quizId, score, total: quiz.questions.length, title: quiz.title, timestamp: new Date() };
            } else {
                user.quizScores.push({ quizId, score, total: quiz.questions.length, title: quiz.title, timestamp: new Date() });
            }
            await users.updateOne({ _id: new ObjectId(req.session.userId) }, { $set: { quizScores: user.quizScores } });
            await updateUserScore(req.session.userId, db);
            console.log('Quiz saved for user:', req.session.userId);
        }
        res.json({ score, total: quiz.questions.length, feedback });
    } catch (err) {
        console.error('Quiz submission error:', err.message);
        res.status(500).json({ error: 'Failed to process quiz: ' + err.message });
    }
});

app.post('/api/pronunciation', async (req, res) => {
    const { lessonId, phrase, isCorrect } = req.body;
    if (!lessonId || !phrase || isCorrect === undefined) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    try {
        const db = await ensureDBConnection();
        if (!db) return res.status(500).json({ error: 'Database unavailable' });
        if (req.session.userId) {
            await db.collection('users').updateOne(
                { _id: new ObjectId(req.session.userId) },
                { $push: { pronunciationScores: { lessonId, phrase, isCorrect, timestamp: new Date() } } }
            );
            await updateUserScore(req.session.userId, db);
            console.log('Pronunciation saved for user:', req.session.userId);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Pronunciation error:', err.message);
        res.status(500).json({ error: 'Failed to process pronunciation: ' + err.message });
    }
});

app.post('/api/grade-writing', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided' });

    try {
        const ltResponse = await axios.post('https://api.languagetool.org/v2/check', {
            text: text,
            language: 'en-US',
            disabledRules: 'WHITESPACE_RULE'
        }, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 8000
        });

        const grammarCheck = ltResponse.data.matches || [];
        const errorCount = grammarCheck.length;
        let grammarScore = Math.max(0, 100 - (errorCount * 10));
        const grammarFeedback = errorCount > 0 
            ? grammarCheck.map(m => `${m.message} (e.g., "${m.context.text.substring(m.context.offset, m.context.offset + m.context.length)}")`)
            : ['No grammar errors found!'];

        const words = text.split(/\s+/).filter(w => w.length > 0);
        const wordCount = words.length;
        const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
        const sentenceCount = sentences.length;
        const avgWordsPerSentence = wordCount / sentenceCount;

        const passiveVoiceCount = text.match(/\b(is|are|was|were|been)\s+\w+ed\b/gi)?.length || 0;
        const uniqueWords = new Set(words.map(w => w.toLowerCase())).size;
        const vocabVariety = uniqueWords / wordCount;
        const styleFeedback = [];
        if (passiveVoiceCount > sentenceCount * 0.2) styleFeedback.push('Too much passive voice—try active voice.');
        if (vocabVariety < 0.7) styleFeedback.push('Use more varied vocabulary.');

        const syllables = words.reduce((sum, word) => sum + (word.match(/[aeiouy]/gi)?.length || 1), 0);
        const fleschScore = 206.835 - 1.015 * (wordCount / sentenceCount) - 84.6 * (syllables / wordCount);
        const readabilityFeedback = fleschScore < 60 ? 'Text is hard to read—simplify sentences or words.' : 'Good readability!';

        const wordCountBonus = Math.min(wordCount / 50, 1) * 30;
        const styleScore = 100 - (passiveVoiceCount * 5 + (vocabVariety < 0.7 ? 10 : 0));
        const totalScore = Math.round((grammarScore * 0.5) + (wordCountBonus * 0.3) + (styleScore * 0.2));
        const cefrData = mapToCEFR(totalScore, wordCount, grammarScore, styleScore);

        const feedback = [
            `Words: ${wordCount}, Sentences: ${sentenceCount}, Avg. Words/Sentence: ${avgWordsPerSentence.toFixed(1)}`,
            `Grammar (${grammarScore}%): ${grammarFeedback.join('; ')}`,
            ...(styleFeedback.length ? [`Style (${styleScore}%): ${styleFeedback.join('; ')}`] : ['Style: No major issues.']),
            `Readability: ${readabilityFeedback} (Flesch Score: ${fleschScore.toFixed(1)})`
        ].join('\n');

        if (req.session.userId) {
            const db = await ensureDBConnection();
            if (db) {
                await db.collection('users').updateOne(
                    { _id: new ObjectId(req.session.userId) },
                    { $push: { writingScores: { score: totalScore, cefr: cefrData.level, timestamp: new Date() } } }
                );
                console.log('Writing score saved for user:', req.session.userId);
            }
        }

        res.json({ score: totalScore, cefr: cefrData.level, feedback });
    } catch (error) {
        console.error('Grading error:', error.message);
        const wordCount = text.split(/\s+/).length;
        const score = Math.min(wordCount / 50 * 100, 100);
        const cefrData = mapToCEFR(score, wordCount, 100, 100);
        res.json({
            score,
            cefr: cefrData.level,
            feedback: 'Grading failed—used basic score: ' + error.message
        });
    }
});

function mapToCEFR(score, wordCount, grammarScore, styleScore) {
    const reasons = [];
    if (score < 20) {
        reasons.push('Very basic text with significant errors.');
        return { level: 'A1', reason: reasons.join(' ') };
    }
    if (score < 40) {
        reasons.push('Simple text with frequent errors.');
        return { level: 'A2', reason: reasons.join(' ') };
    }
    if (score < 60) {
        reasons.push('Coherent ideas but noticeable errors.');
        return { level: 'B1', reason: reasons.join(' ') };
    }
    if (score < 80) {
        reasons.push('Complex ideas with some errors.');
        return { level: 'B2', reason: reasons.join(' ') };
    }
    if (score < 95) {
        reasons.push('Fluent text with minor errors.');
        return { level: 'C1', reason: reasons.join(' ') };
    }
    reasons.push('Near-native fluency with minimal errors.');
    if (wordCount < 50) reasons.push('Text too short—aim for 50+ words.');
    if (grammarScore < 70) reasons.push('Work on grammar accuracy.');
    if (styleScore < 70) reasons.push('Improve style.');
    return { level: 'C2', reason: reasons.join(' ') };
}

app.get('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err.message);
            return res.status(500).json({ error: 'Logout failed' });
        }
        console.log('Logout successful');
        res.redirect('/');
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing MongoDB connection');
    if (client) await client.close();
    process.exit(0);
});