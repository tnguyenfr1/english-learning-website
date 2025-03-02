const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcrypt');
const stripe = require('stripe')('sk_test_51YourActualStripeSecretKey'); 
const app = express();

app.use(express.json());
app.use(express.static('public'));

console.log('Server starting...');

const mongoURI = 'mongodb+srv://admin:securepassword123@englishlearningcluster.bhzo4.mongodb.net/english_learning?retryWrites=true&w=majority&appName=EnglishLearningCluster'; 
let dbConnected = false;
async function connectToMongoDB() {
    try {
        await mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true });
        console.log('Connected to MongoDB Atlas - english_learning');
        dbConnected = true;
    } catch (err) {
        console.error('MongoDB connection error:', err.message);
        dbConnected = false;
    }
}
connectToMongoDB();

app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 day
}));

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

// Login Endpoint
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    console.log('Login attempt:', { email });
    try {
        if (!dbConnected) {
            console.log('DB not connected, using fallback login');
            req.session.userId = 'fallback-id';
            return res.status(200).send();
        }
        const user = await User.findOne({ email });
        if (!user) {
            console.log('User not found:', email);
            return res.status(401).send('Invalid credentials');
        }
        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            console.log('Password mismatch for:', email);
            return res.status(401).send('Invalid credentials');
        }
        req.session.userId = user._id;
        console.log('Login successful:', email, 'Session ID:', req.session.userId);
        res.status(200).send();
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
    }
});

// Signup Endpoint
app.post('/api/signup', async (req, res) => {
    const { email, password, name } = req.body;
    console.log('Signup attempt:', { email });
    try {
        if (!dbConnected) {
            console.log('DB not connected, signup failed');
            return res.status(500).json({ error: 'Database unavailable, signup failed' });
        }
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
        console.error('Signup error:', err.message);
        res.status(500).json({ error: 'Server error - Signup failed: ' + err.message });
    }
});

// User Data Endpoint
app.get('/api/user-data', async (req, res) => {
    console.log('User data request, session:', req.session);
    if (!req.session.userId) {
        console.log('No session userId');
        return res.status(401).send('Not logged in');
    }
    try {
        if (!dbConnected) {
            console.log('DB not connected, using fallback data');
            return res.json({ 
                name: 'Fallback User', 
                score: 49, 
                achievements: [{ name: 'Pronunciation Pro', dateEarned: new Date() }] 
            });
        }
        const user = await User.findById(req.session.userId);
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
            achievements: user.achievements || []
        };
        console.log('User data sent:', data);
        res.json(data);
    } catch (err) {
        console.error('User data error:', err.message);
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
    }
});

// Lessons Endpoint
app.get('/lessons', async (req, res) => {
    console.log('Lessons request');
    try {
        if (!dbConnected) {
            console.log('DB not connected, using sample lessons');
            return res.json([
                { _id: '1', title: 'Sample Lesson 1', content: 'This is a sample lesson.', level: 'B1', createdAt: new Date() }
            ]);
        }
        const lessons = await Lesson.find().sort({ createdAt: -1 });
        console.log('Lessons sent:', lessons);
        res.json(lessons);
    } catch (err) {
        console.error('Lessons error:', err.message);
        res.status(404).json({ error: 'Lessons not found' });
    }
});

// References Endpoint
app.get('/references', async (req, res) => {
    console.log('References request');
    try {
        if (!dbConnected) {
            console.log('DB not connected, using sample references');
            return res.json([
                { _id: '1', title: 'Sample Reference', url: 'https://example.com', description: 'A sample resource' }
            ]);
        }
        const references = await Reference.find();
        console.log('References sent:', references);
        res.json(references);
    } catch (err) {
        console.error('References error:', err.message);
        res.status(404).json({ error: 'References not found' });
    }
});

// Blogs Endpoint
app.get('/blogs', async (req, res) => {
    console.log('Blogs request');
    try {
        if (!dbConnected) {
            console.log('DB not connected, using sample blogs');
            return res.json([
                { _id: '1', title: 'Sample Blog', content: 'This is a sample blog post.', createdAt: new Date() }
            ]);
        }
        const blogs = await Blog.find().sort({ createdAt: -1 });
        console.log('Blogs sent:', blogs);
        res.json(blogs);
    } catch (err) {
        console.error('Blogs error:', err.message);
        res.status(404).json({ error: 'Blogs not found' });
    }
});

// Quizzes Endpoint
app.get('/quizzes', async (req, res) => {
    console.log('Quizzes request');
    try {
        if (!dbConnected) {
            console.log('DB not connected, using sample quizzes');
            return res.json([
                { _id: '1', title: 'Sample Quiz', type: 'fill-in', questions: [{ prompt: 'What is 2+2?', correctAnswer: '4' }], timeLimit: 60, level: 'B1', createdAt: new Date() }
            ]);
        }
        const quizzes = await Quiz.find().sort({ createdAt: -1 });
        console.log('Quizzes sent:', quizzes);
        res.json(quizzes);
    } catch (err) {
        console.error('Quizzes error:', err.message);
        res.status(404).json({ error: 'Quizzes not found' });
    }
});

// Leaderboard Endpoint
app.get('/leaderboard', async (req, res) => {
    console.log('Leaderboard request');
    try {
        if (!dbConnected) {
            console.log('DB not connected, using sample leaderboard');
            return res.json([{ name: 'Fallback User', score: 49 }]);
        }
        const users = await User.find({}, 'name score').sort({ score: -1 }).limit(10);
        console.log('Leaderboard sent:', users);
        res.json(users);
    } catch (err) {
        console.error('Leaderboard error:', err.message);
        res.status(404).json({ error: 'Leaderboard not found' });
    }
});

// Logout Endpoint
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
