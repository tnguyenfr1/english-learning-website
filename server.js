const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoDBStore = require('connect-mongodb-session')(session);
const bcrypt = require('bcrypt');
const stripe = require('stripe')('sk_test_51YourActualStripeSecretKey'); // Replace with your real key
const app = express();

app.use(express.json());
app.use(express.static('public'));

const mongoURI = 'mongodb+srv://admin:securepassword123@englishlearningcluster.bhzo4.mongodb.net/english_learning?retryWrites=true&w=majority&appName=EnglishLearningCluster';
const store = new MongoDBStore({
    uri: mongoURI,
    collection: 'sessions'
});
store.on('error', (error) => console.error('Session store error:', error));

app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    store: store,
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 day
}));

mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('Connected to MongoDB Atlas'))
    .catch(err => console.error('MongoDB connection error:', err));

// Schemas
const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    name: { type: String, default: 'Student' },
    score: { type: Number, default: 0 },
    homeworkScores: [{ lessonId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson' }, score: { type: Number, default: 0 } }],
    pronunciationScores: [{ lessonId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson' }, phrase: String, correct: Boolean, attempts: { type: Number, default: 1 } }],
    comprehensionScores: [{ lessonId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson' }, score: { type: Number, default: 0 } }],
    quizScores: [{ quizId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz' }, score: { type: Number, default: 0 } }],
    referencesVisited: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Reference' }],
    achievements: [{ name: String, dateEarned: { type: Date, default: Date.now } }],
    admin: { type: Boolean, default: false }
});
const User = mongoose.model('User', UserSchema);

const LessonSchema = new mongoose.Schema({
    title: { type: String, required: true },
    content: { type: String, required: true },
    homework: [{ question: String, type: { type: String, enum: ['fill-in', 'multiple-choice'], default: 'fill-in' }, correctAnswer: String, options: [String] }],
    comprehension: { questions: [{ question: String, correctAnswer: Boolean, text: String }] },
    pronunciation: [{ phrase: String }],
    level: { type: String, enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'], default: 'B1' },
    createdAt: { type: Date, default: Date.now }
});
const Lesson = mongoose.model('Lesson', LessonSchema);

const ReferenceSchema = new mongoose.Schema({
    title: String,
    url: String,
    description: String
});
const Reference = mongoose.model('Reference', ReferenceSchema);

const BlogSchema = new mongoose.Schema({
    title: String,
    content: String,
    createdAt: { type: Date, default: Date.now }
});
const Blog = mongoose.model('Blog', BlogSchema);

const QuizSchema = new mongoose.Schema({
    title: String,
    type: { type: String, enum: ['matching', 'fill-in'], required: true },
    questions: [{ prompt: String, correctAnswer: String, options: [String] }],
    timeLimit: Number,
    level: { type: String, enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'], default: 'B1' },
    createdAt: { type: Date, default: Date.now }
});
const Quiz = mongoose.model('Quiz', QuizSchema);

// Helper Functions
async function recalculateUserScore(user) {
    const allLessons = await Lesson.find();
    const totalTasks = allLessons.length * 3;
    const homeworkTotal = (user.homeworkScores || []).reduce((sum, s) => sum + s.score, 0);
    const pronunciationTotal = (user.pronunciationScores || []).filter(s => s.correct).length * 100;
    const comprehensionTotal = (user.comprehensionScores || []).reduce((sum, s) => sum + s.score, 0);
    const quizTotal = (user.quizScores || []).reduce((sum, s) => sum + s.score, 0);
    const totalPossibleScore = totalTasks * 100 + (user.quizScores || []).length * 100;
    user.score = totalPossibleScore > 0 ? Math.round((homeworkTotal + pronunciationTotal + comprehensionTotal + quizTotal) / totalPossibleScore * 100) : 0;
    await checkAchievements(user);
    await user.save();
    return user.score;
}

async function checkAchievements(user) {
    if (!user.achievements) user.achievements = [];
    const pronunciationCount = (user.pronunciationScores || []).filter(s => s.correct).length;
    const referencesCount = (user.referencesVisited || []).length;
    const quizCount = (user.quizScores || []).length;

    if (pronunciationCount >= 10 && !user.achievements.some(a => a.name === 'Pronunciation Pro')) {
        user.achievements.push({ name: 'Pronunciation Pro' });
    }
    if (referencesCount >= 5 && !user.achievements.some(a => a.name === 'Blog Explorer')) {
        user.achievements.push({ name: 'Blog Explorer' });
    }
    if (quizCount >= 3 && !user.achievements.some(a => a.name === 'Quiz Master')) {
        user.achievements.push({ name: 'Quiz Master' });
    }
}

// API Endpoints
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    console.log('Login attempt:', { email });
    try {
        const user = await User.findOne({ email });
        if (!user || !await bcrypt.compare(password, user.password)) {
            console.log('Invalid credentials for:', email);
            return res.status(401).send('Invalid credentials');
        }
        req.session.userId = user._id;
        console.log('Login successful:', email, 'Session ID:', req.session.userId);
        res.status(200).send();
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/signup', async (req, res) => {
    const { email, password, name } = req.body;
    console.log('Signup attempt:', { email });
    try {
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            console.log('Email already in use:', email);
            return res.status(400).send('Email already in use');
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = new User({ email, password: hashedPassword, name });
        await user.save();
        console.log('Signup successful:', email);
        res.status(201).send();
    } catch (err) {
        console.error('Signup error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/user-data', async (req, res) => {
    if (!req.session.userId) {
        console.log('No session userId');
        return res.status(401).send('Not logged in');
    }
    try {
        const user = await User.findById(req.session.userId);
        if (!user) {
            console.log('User not found:', req.session.userId);
            return res.status(404).send('User not found');
        }
        const homeworkScores = user.homeworkScores || [];
        const pronunciationScores = user.pronunciationScores || [];
        const comprehensionScores = user.comprehensionScores || [];
        const quizScores = user.quizScores || [];
        const referencesVisited = user.referencesVisited || [];
        const achievements = user.achievements || [];
        console.log('User data sent:', { name: user.name, score: user.score });
        res.json({ name: user.name, score: user.score, homeworkScores, pronunciationScores, comprehensionScores, quizScores, referencesVisited, achievements });
    } catch (err) {
        console.error('User data error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/logout', (req, res) => {
    console.log('Logout attempt');
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
            return res.status(500).json({ error: 'Logout failed' });
        }
        console.log('Logout successful');
        res.redirect('/index.html');
    });
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));