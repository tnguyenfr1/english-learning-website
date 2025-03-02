const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcrypt');
const stripe = require('stripe')('sk_test_51YourActualStripeSecretKey'); // Replace with your real key
const app = express();

app.use(express.json());
app.use(express.static('public'));

console.log('Server starting...');

const mongoURI = 'mongodb+srv://admin:securepassword123@englishlearningcluster.bhzo4.mongodb.net/english_learning?retryWrites=true&w=majority&appName=EnglishLearningCluster'; // Replace <db_password> with your real password
let dbConnected = false;

mongoose.set('bufferCommands', false); // Disable buffering for serverless
const mongoOptions = {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000, // 5s timeout
    connectTimeoutMS: 10000 // 10s connect timeout
};

// Connect to MongoDB with retry logic
async function connectToMongoDB() {
    try {
        if (!mongoose.connection.readyState) { // Only connect if not already connected
            await mongoose.connect(mongoURI, mongoOptions);
            console.log('Connected to MongoDB Atlas - english_learning');
            dbConnected = true;
        } else {
            console.log('MongoDB already connected');
            dbConnected = true;
        }
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
    homeworkScores: [{ lessonId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson' }, score: { type: Number, default: 0 }, title: String }],
    pronunciationScores: [{ lessonId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson' }, phrase: String, correct: Boolean, attempts: { type: Number, default: 1 } }],
    comprehensionScores: [{ lessonId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson' }, score: { type: Number, default: 0 }, title: String }],
    quizScores: [{ quizId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz' }, score: { type: Number, default: 0 }, title: String }],
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

// Update User Score Function
async function updateUserScore(userId) {
    const user = await User.findById(userId);
    if (!user) return;

    const categories = [
        { scores: user.homeworkScores || [], max: 12 },
        { scores: user.comprehensionScores || [], max: 12 },
        { scores: user.quizScores || [], max: 2 },
        { scores: user.pronunciationScores || [], max: 12, isBool: true }
    ];

    let totalScore = 0;
    let totalWeight = 0;

    for (const category of categories) {
        if (category.scores.length > 0) {
            const count = Math.min(category.scores.length, category.max); // Cap at max
            const avg = category.isBool 
                ? (category.scores.filter(s => s.correct).length / category.max) * 100 
                : category.scores.reduce((sum, s) => sum + s.score, 0) / category.max;
            totalScore += avg;
            totalWeight += 1; // Each category contributes equally when present
        }
    }

    user.score = totalWeight > 0 ? Math.round(totalScore / 4) : 0; // Divide by total possible categories (4)
    await user.save();
    console.log('Updated user score:', user.score);

    // Fix missing titles in existing scores
    for (let i = 0; i < user.homeworkScores.length; i++) {
        if (!user.homeworkScores[i].title || user.homeworkScores[i].title === 'Untitled Lesson') {
            const lesson = await Lesson.findById(user.homeworkScores[i].lessonId);
            user.homeworkScores[i].title = lesson ? lesson.title : 'Unknown Lesson';
        }
    }
    for (let i = 0; i < user.comprehensionScores.length; i++) {
        if (!user.comprehensionScores[i].title || user.comprehensionScores[i].title === 'Untitled Lesson') {
            const lesson = await Lesson.findById(user.comprehensionScores[i].lessonId);
            user.comprehensionScores[i].title = lesson ? lesson.title : 'Unknown Lesson';
        }
    }
    for (let i = 0; i < user.quizScores.length; i++) {
        if (!user.quizScores[i].title || user.quizScores[i].title === 'Untitled Quiz') {
            const quiz = await Quiz.findById(user.quizScores[i].quizId);
            user.quizScores[i].title = quiz ? quiz.title : 'Unknown Quiz';
        }
    }
    await user.save();
    console.log('Updated titles for user scores');
}

// Login Endpoint
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    console.log('Login attempt:', { email });
    try {
        await connectToMongoDB();
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
        await connectToMongoDB();
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
        await connectToMongoDB();
        if (!dbConnected) {
            console.log('DB not connected, using fallback data');
            return res.json({ 
                name: 'Fallback User', 
                score: 49, 
                achievements: [{ name: 'Pronunciation Pro', dateEarned: new Date() }] 
            });
        }
        await updateUserScore(req.session.userId); // Ensure score and titles are up-to-date
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
        await connectToMongoDB();
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
        await connectToMongoDB();
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
        await connectToMongoDB();
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
        await connectToMongoDB();
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
        await connectToMongoDB();
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

// Comprehension Endpoint
app.post('/comprehension', async (req, res) => {
    console.log('Comprehension request:', req.body);
    if (!req.session.userId) {
        console.log('No session userId');
        return res.status(401).send('Not logged in');
    }
    const { lessonId, answers } = req.body;
    try {
        await connectToMongoDB();
        if (!dbConnected) {
            console.log('DB not connected, comprehension failed');
            return res.status(500).json({ error: 'Database unavailable' });
        }
        const lesson = await Lesson.findById(lessonId);
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

        const user = await User.findById(req.session.userId);
        if (!user.comprehensionScores) user.comprehensionScores = [];
        const existingScoreIndex = user.comprehensionScores.findIndex(s => s.lessonId.toString() === lessonId);
        if (existingScoreIndex !== -1) {
            user.comprehensionScores[existingScoreIndex].score = comprehensionScore;
            user.comprehensionScores[existingScoreIndex].title = lesson.title;
        } else {
            user.comprehensionScores.push({ lessonId, score: comprehensionScore, title: lesson.title });
        }
        await user.save();
        await updateUserScore(req.session.userId);
        console.log('Comprehension processed:', { lessonId, comprehensionScore });
        res.json({ score: score, total: lesson.comprehension.questions.length, feedback });
    } catch (err) {
        console.error('Comprehension error:', err.message);
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
    }
});

// Homework Endpoint
app.post('/homework', async (req, res) => {
    console.log('Homework request:', req.body);
    if (!req.session.userId) {
        console.log('No session userId');
        return res.status(401).send('Not logged in');
    }
    const { lessonId, answers } = req.body;
    try {
        await connectToMongoDB();
        if (!dbConnected) {
            console.log('DB not connected, homework failed');
            return res.status(500).json({ error: 'Database unavailable' });
        }
        const lesson = await Lesson.findById(lessonId);
        if (!lesson || !lesson.homework || lesson.homework.length === 0) {
            console.log('Lesson or homework not found:', lessonId);
            return res.status(404).send('Lesson or homework not found');
        }
        let score = 0;
        const feedback = lesson.homework.map((q, i) => {
            const isCorrect = answers[i] === q.correctAnswer;
            if (isCorrect) score++;
            return { question: q.question, correct: isCorrect, correctAnswer: q.correctAnswer };
        });
        const homeworkScore = Math.round((score / lesson.homework.length) * 100);

        const user = await User.findById(req.session.userId);
        if (!user.homeworkScores) user.homeworkScores = [];
        const existingScoreIndex = user.homeworkScores.findIndex(s => s.lessonId.toString() === lessonId);
        if (existingScoreIndex !== -1) {
            user.homeworkScores[existingScoreIndex].score = homeworkScore;
            user.homeworkScores[existingScoreIndex].title = lesson.title;
        } else {
            user.homeworkScores.push({ lessonId, score: homeworkScore, title: lesson.title });
        }
        await user.save();
        await updateUserScore(req.session.userId);
        console.log('Homework processed:', { lessonId, homeworkScore });
        res.json({ score: score, total: lesson.homework.length, feedback });
    } catch (err) {
        console.error('Homework error:', err.message);
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
    }
});

// Quiz Submission Endpoint
app.post('/submit-quiz', async (req, res) => {
    console.log('Quiz submission request:', req.body);
    if (!req.session.userId) {
        console.log('No session userId');
        return res.status(401).send('Not logged in');
    }
    const { quizId, answers } = req.body;
    try {
        await connectToMongoDB();
        if (!dbConnected) {
            console.log('DB not connected, quiz submission failed');
            return res.status(500).json({ error: 'Database unavailable' });
        }
        const quiz = await Quiz.findById(quizId);
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

        const user = await User.findById(req.session.userId);
        if (!user.quizScores) user.quizScores = [];
        const existingScoreIndex = user.quizScores.findIndex(s => s.quizId.toString() === quizId);
        if (existingScoreIndex !== -1) {
            user.quizScores[existingScoreIndex].score = quizScore;
            user.quizScores[existingScoreIndex].title = quiz.title;
        } else {
            user.quizScores.push({ quizId, score: quizScore, title: quiz.title });
        }
        await user.save();
        await updateUserScore(req.session.userId);
        console.log('Quiz processed:', { quizId, quizScore });
        res.json({ score: score, total: quiz.questions.length, feedback });
    } catch (err) {
        console.error('Quiz submission error:', err.message);
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
    }
});

// Pronunciation Endpoint
app.post('/pronunciation', async (req, res) => {
    console.log('Pronunciation request:', req.body);
    if (!req.session.userId) {
        console.log('No session userId');
        return res.status(401).send('Not logged in');
    }
    const { lessonId, phrase, isCorrect } = req.body;
    try {
        await connectToMongoDB();
        if (!dbConnected) {
            console.log('DB not connected, pronunciation failed');
            return res.status(500).json({ error: 'Database unavailable' });
        }
        const lesson = await Lesson.findById(lessonId);
        if (!lesson || !lesson.pronunciation || !lesson.pronunciation.some(p => p.phrase === phrase)) {
            console.log('Lesson or phrase not found:', { lessonId, phrase });
            return res.status(404).send('Lesson or phrase not found');
        }
        const user = await User.findById(req.session.userId);
        if (!user.pronunciationScores) user.pronunciationScores = [];
        const existingScoreIndex = user.pronunciationScores.findIndex(s => s.lessonId.toString() === lessonId && s.phrase === phrase);
        if (existingScoreIndex !== -1) {
            user.pronunciationScores[existingScoreIndex].correct = isCorrect;
            user.pronunciationScores[existingScoreIndex].attempts += 1;
        } else {
            user.pronunciationScores.push({ lessonId, phrase, correct: isCorrect, attempts: 1 });
        }
        await user.save();
        await updateUserScore(req.session.userId);
        console.log('Pronunciation saved:', { lessonId, phrase, isCorrect });
        res.send('Pronunciation recorded');
    } catch (err) {
        console.error('Pronunciation error:', err.message);
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
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