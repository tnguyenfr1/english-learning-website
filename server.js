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
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('Connected to MongoDB Atlas'))
    .catch(err => console.error('MongoDB connection error:', err));

const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    name: { type: String, default: 'Student' },
    score: { type: Number, default: 0 },
    homeworkScores: [{ lessonId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson' }, score: { type: Number, default: 0 } }],
    pronunciationScores: [{ lessonId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson' }, phrase: String, correct: Boolean, attempts: { type: Number, default: 1 } }],
    comprehensionScores: [{ lessonId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lesson' }, score: { type: Number, default: 0 } }],
    quizScores: [{ quizId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz' }, score: { type: Number, default: 0 } }], // New field
    referencesVisited: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Reference' }],
    achievements: [{ name: String, dateEarned: { type: Date, default: Date.now } }], // New field
    admin: { type: Boolean, default: false }
});
const User = mongoose.model('User', UserSchema);

const LessonSchema = new mongoose.Schema({
    title: { type: String, required: true },
    content: { type: String, required: true },
    homework: [{ question: String, type: { type: String, enum: ['fill-in', 'multiple-choice'], default: 'fill-in' }, correctAnswer: String, options: [String] }],
    comprehension: { questions: [{ question: String, correctAnswer: Boolean, text: String }] }, // Simplified—no text field
    pronunciation: [{ phrase: String }],
    level: { type: String, enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'], default: 'B1' },
    createdAt: { type: Date, default: Date.now }
});
const Lesson = mongoose.model('Lesson', LessonSchema);

// ... rest of server.js unchanged

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
    questions: [{
        prompt: String,
        correctAnswer: String,
        options: [String] // For matching type, optional
    }],
    timeLimit: Number, // Seconds
    level: { type: String, enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'], default: 'B1' },
    createdAt: { type: Date, default: Date.now }
});
const Quiz = mongoose.model('Quiz', QuizSchema);

async function recalculateUserScore(user) {
    const allLessons = await Lesson.find();
    const totalTasks = allLessons.length * 3;
    const homeworkTotal = (user.homeworkScores || []).reduce((sum, s) => sum + s.score, 0);
    const pronunciationTotal = (user.pronunciationScores || []).filter(s => s.correct).length * 100;
    const comprehensionTotal = (user.comprehensionScores || []).reduce((sum, s) => sum + s.score, 0);
    const quizTotal = (user.quizScores || []).reduce((sum, s) => sum + s.score, 0);
    const totalPossibleScore = totalTasks * 100 + (user.quizScores || []).length * 100; // Adjust for quizzes
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

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    console.log('Login attempt:', { email });
    try {
        const user = await User.findOne({ email });
        if (!user) {
            console.log('User not found:', email);
            return res.status(401).send('Invalid credentials');
        }
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            console.log('Password mismatch for:', email);
            return res.status(401).send('Invalid credentials');
        }
        if (!user.homeworkScores) user.homeworkScores = [];
        if (!user.pronunciationScores) user.pronunciationScores = [];
        if (!user.comprehensionScores) user.comprehensionScores = [];
        if (!user.quizScores) user.quizScores = [];
        if (!user.referencesVisited) user.referencesVisited = [];
        if (!user.achievements) user.achievements = [];
        await user.save();
        req.session.userId = user._id;
        console.log('Login successful:', email, 'Session ID:', req.session.userId);
        res.status(200).send();
    } catch (err) {
        console.error('Login error:', err.message, err.stack);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

app.post('/signup', async (req, res) => {
    const { email, password, name } = req.body;
    console.log('Signup attempt:', { email });
    try {
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            console.log('Email already in use:', email);
            return res.status(400).send('Email already in use');
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = new User({ email, password: hashedPassword, name, quizScores: [], referencesVisited: [], achievements: [] });
        await user.save();
        console.log('Signup successful:', email);
        res.status(201).send();
    } catch (err) {
        console.error('Signup error:', err.message, err.stack);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

app.get('/user-data', async (req, res) => {
    if (!req.session.userId) {
        console.log('No session userId for user-data');
        return res.status(401).send('Not logged in');
    }
    try {
        const user = await User.findById(req.session.userId);
        if (!user) {
            console.log('User not found:', req.session.userId);
            return res.status(404).send('User not found');
        }
        if (!user.pronunciationScores) user.pronunciationScores = [];
        if (!user.comprehensionScores) user.comprehensionScores = [];
        if (!user.quizScores) user.quizScores = [];
        if (!user.referencesVisited) user.referencesVisited = [];
        if (!user.achievements) user.achievements = [];
        const homeworkScoresWithTitles = await Promise.all(
            (user.homeworkScores || []).map(async (hs) => {
                const lesson = await Lesson.findById(hs.lessonId);
                if (!lesson) return null;
                return { lessonId: hs.lessonId, title: lesson.title, score: hs.score };
            })
        ).then(results => results.filter(Boolean));
        const comprehensionScoresWithTitles = await Promise.all(
            (user.comprehensionScores || []).map(async (cs) => {
                const lesson = await Lesson.findById(cs.lessonId);
                if (!lesson) return null;
                return { lessonId: cs.lessonId, title: lesson.title, score: cs.score };
            })
        ).then(results => results.filter(Boolean));
        const quizScoresWithTitles = await Promise.all(
            (user.quizScores || []).map(async (qs) => {
                const quiz = await Quiz.findById(qs.quizId);
                if (!quiz) return null;
                return { quizId: qs.quizId, title: quiz.title, score: qs.score };
            })
        ).then(results => results.filter(Boolean));

        // Personalized recommendation logic
        const homeworkAvg = homeworkScoresWithTitles.length > 0 ? homeworkScoresWithTitles.reduce((sum, s) => sum + s.score, 0) / homeworkScoresWithTitles.length : 100;
        const comprehensionAvg = comprehensionScoresWithTitles.length > 0 ? comprehensionScoresWithTitles.reduce((sum, s) => sum + s.score, 0) / comprehensionScoresWithTitles.length : 100;
        const pronunciationAvg = user.pronunciationScores.length > 0 ? (user.pronunciationScores.filter(s => s.correct).length / user.pronunciationScores.length) * 100 : 100;
        let recommendation = '';
        if (homeworkAvg < 70) recommendation = 'Focus on homework—try “Daily Life in a Small Town” (A2).';
        else if (comprehensionAvg < 70) recommendation = 'Focus on comprehension—try “Cultural Influences” (B1).';
        else if (pronunciationAvg < 70) recommendation = 'Focus on pronunciation—try “Environmental Challenges” (B1).';
        else recommendation = 'You’re doing great—challenge yourself with “Global Economic Trends” (C1)!';

        console.log('User data sent:', { 
            name: user.name, 
            score: user.score, 
            homeworkScores: homeworkScoresWithTitles,
            pronunciationScores: user.pronunciationScores,
            comprehensionScores: comprehensionScoresWithTitles,
            quizScores: quizScoresWithTitles,
            referencesVisited: user.referencesVisited,
            achievements: user.achievements,
            recommendation
        });
        res.json({ 
            name: user.name, 
            score: user.score, 
            homeworkScores: homeworkScoresWithTitles,
            pronunciationScores: user.pronunciationScores,
            comprehensionScores: comprehensionScoresWithTitles,
            quizScores: quizScoresWithTitles,
            referencesVisited: user.referencesVisited,
            achievements: user.achievements,
            recommendation
        });
    } catch (err) {
        console.error('User data error:', err.message, err.stack);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

app.get('/lessons', async (req, res) => {
    console.log('Fetching lessons');
    try {
        const lessons = await Lesson.find().sort({ createdAt: -1 });
        console.log('Lessons fetched:', lessons.length);
        res.json(lessons);
    } catch (err) {
        console.error('Lessons fetch error:', err.message, err.stack);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

app.post('/lessons', async (req, res) => {
    if (!req.session.userId) {
        console.log('No session userId for lessons creation');
        return res.status(401).send('Not logged in');
    }
    try {
        const user = await User.findById(req.session.userId);
        if (!user.admin) {
            console.log('Unauthorized lesson creation attempt:', user.email);
            return res.status(403).send('Not authorized');
        }
        const { title, content, homework, comprehension, pronunciation, level } = req.body;
        const lesson = new Lesson({ title, content, homework, comprehension, pronunciation, level });
        await lesson.save();
        console.log('Lesson created:', title);
        res.status(201).send();
    } catch (err) {
        console.error('Lesson creation error:', err.message, err.stack);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

app.post('/homework', async (req, res) => {
    console.log('Homework route hit:', req.body, 'Session:', req.session);
    if (!req.session.userId) {
        console.log('No session userId');
        return res.status(401).send('Not logged in');
    }
    const { lessonId, answers } = req.body;
    try {
        const lesson = await Lesson.findById(lessonId);
        if (!lesson || !lesson.homework) {
            console.log('Lesson or homework not found:', lessonId);
            return res.status(404).send('Lesson or homework not found');
        }
        let score = 0;
        const feedback = lesson.homework.map((q, i) => {
            const isCorrect = answers[i].toLowerCase().trim() === q.correctAnswer.toLowerCase().trim();
            if (isCorrect) score++;
            return { question: q.question, correct: isCorrect, correctAnswer: q.correctAnswer };
        });
        const homeworkScore = Math.round((score / lesson.homework.length) * 100);

        const user = await User.findById(req.session.userId);
        if (!user.homeworkScores) user.homeworkScores = [];
        const existingScoreIndex = user.homeworkScores.findIndex(s => s.lessonId.toString() === lessonId);
        if (existingScoreIndex !== -1) {
            user.homeworkScores[existingScoreIndex].score = homeworkScore;
        } else {
            user.homeworkScores.push({ lessonId, score: homeworkScore });
        }
        await recalculateUserScore(user);

        console.log('Homework processed:', { lessonId, lessonScore: homeworkScore, totalScore: user.score });
        res.json({ score: score, total: lesson.homework.length, feedback });
    } catch (err) {
        console.error('Homework error:', err.message, err.stack);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

app.post('/comprehension', async (req, res) => {
    console.log('Comprehension route hit:', req.body, 'Session:', req.session);
    if (!req.session.userId) {
        console.log('No session userId');
        return res.status(401).send('Not logged in');
    }
    const { lessonId, answers } = req.body;
    try {
        const lesson = await Lesson.findById(lessonId);
        if (!lesson || !lesson.comprehension || !lesson.comprehension.questions || lesson.comprehension.questions.length === 0) {
            console.log('Lesson or comprehension questions not found or empty:', lessonId);
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
        } else {
            user.comprehensionScores.push({ lessonId, score: comprehensionScore });
        }
        await recalculateUserScore(user);

        console.log('Comprehension processed:', { lessonId, comprehensionScore, totalScore: user.score });
        res.json({ score: score, total: lesson.comprehension.questions.length, feedback });
    } catch (err) {
        console.error('Comprehension error:', err.message, err.stack);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

app.post('/pronunciation', async (req, res) => {
    console.log('Pronunciation route hit:', req.body, 'Session:', req.session);
    if (!req.session.userId) {
        console.log('No session userId');
        return res.status(401).send('Not logged in');
    }
    const { lessonId, phrase, isCorrect } = req.body;
    try {
        const user = await User.findById(req.session.userId);
        if (!user) {
            console.log('User not found:', req.session.userId);
            return res.status(404).send('User not found');
        }
        if (!user.pronunciationScores) user.pronunciationScores = [];
        const existingEntry = user.pronunciationScores.find(s => s.lessonId.toString() === lessonId && s.phrase === phrase);
        if (existingEntry) {
            existingEntry.correct = isCorrect || existingEntry.correct;
            existingEntry.attempts += 1;
        } else {
            user.pronunciationScores.push({ lessonId, phrase, correct: isCorrect, attempts: 1 });
        }
        await recalculateUserScore(user);

        console.log('Pronunciation saved successfully:', { lessonId, phrase, isCorrect, attempts: existingEntry ? existingEntry.attempts : 1, totalScore: user.score });
        res.status(200).send('Pronunciation saved');
    } catch (err) {
        console.error('Pronunciation error:', err.message, err.stack);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

app.get('/references', async (req, res) => {
    console.log('Fetching references');
    try {
        const references = await Reference.find();
        console.log('References fetched:', references.length);
        res.json(references);
    } catch (err) {
        console.error('References fetch error:', err.message, err.stack);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

app.post('/mark-reference-visited', async (req, res) => {
    if (!req.session.userId) {
        console.log('No session userId for marking reference');
        return res.status(401).send('Not logged in');
    }
    const { referenceId } = req.body;
    try {
        const user = await User.findById(req.session.userId);
        if (!user.referencesVisited) user.referencesVisited = [];
        if (!user.referencesVisited.includes(referenceId)) {
            user.referencesVisited.push(referenceId);
            await user.save();
            console.log('Reference marked as visited:', { userId: req.session.userId, referenceId });
        }
        res.status(200).send();
    } catch (err) {
        console.error('Mark reference error:', err.message, err.stack);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

app.post('/create-checkout-session', async (req, res) => {
    console.log('Creating checkout session', req.body);
    try {
        const origin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Donation to English Learning Platform'
                    },
                    unit_amount: 500
                },
                quantity: 1
            }],
            mode: 'payment',
            success_url: `${origin}/dashboard.html?success=true`,
            cancel_url: `${origin}/dashboard.html?cancel=true`
        });
        console.log('Checkout session created:', session.id);
        res.json({ id: session.id });
    } catch (err) {
        console.error('Checkout session error:', err.message, err.stack);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

app.get('/blogs', async (req, res) => {
    console.log('Fetching blogs');
    try {
        const blogs = await Blog.find().sort({ createdAt: -1 });
        console.log('Blogs fetched:', blogs.length);
        res.json(blogs);
    } catch (err) {
        console.error('Blogs fetch error:', err.message, err.stack);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

app.post('/blogs', async (req, res) => {
    if (!req.session.userId) {
        console.log('No session userId for blog creation');
        return res.status(401).send('Not logged in');
    }
    try {
        const user = await User.findById(req.session.userId);
        if (!user.admin) {
            console.log('Unauthorized blog creation attempt:', user.email);
            return res.status(403).send('Not authorized');
        }
        const { title, content } = req.body;
        const blog = new Blog({ title, content });
        await blog.save();
        console.log('Blog created:', title);
        res.status(201).send();
    } catch (err) {
        console.error('Blog creation error:', err.message, err.stack);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

app.get('/leaderboard', async (req, res) => {
    console.log('Fetching leaderboard');
    try {
        const users = await User.find({}, 'name score').sort({ score: -1 }).limit(10);
        console.log('Leaderboard fetched:', users.length);
        res.json(users);
    } catch (err) {
        console.error('Leaderboard fetch error:', err.message, err.stack);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

app.get('/quizzes', async (req, res) => {
    console.log('Fetching quizzes');
    try {
        const quizzes = await Quiz.find().sort({ createdAt: -1 });
        console.log('Quizzes fetched:', quizzes.length);
        res.json(quizzes);
    } catch (err) {
        console.error('Quizzes fetch error:', err.message, err.stack);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

app.post('/quizzes', async (req, res) => {
    if (!req.session.userId) {
        console.log('No session userId for quiz creation');
        return res.status(401).send('Not logged in');
    }
    try {
        const user = await User.findById(req.session.userId);
        if (!user.admin) {
            console.log('Unauthorized quiz creation attempt:', user.email);
            return res.status(403).send('Not authorized');
        }
        const { title, type, questions, timeLimit, level } = req.body;
        const quiz = new Quiz({ title, type, questions, timeLimit, level });
        await quiz.save();
        console.log('Quiz created:', title);
        res.status(201).send();
    } catch (err) {
        console.error('Quiz creation error:', err.message, err.stack);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

app.post('/submit-quiz', async (req, res) => {
    console.log('Quiz submission route hit:', req.body, 'Session:', req.session);
    if (!req.session.userId) {
        console.log('No session userId');
        return res.status(401).send('Not logged in');
    }
    const { quizId, answers } = req.body;
    try {
        const quiz = await Quiz.findById(quizId);
        if (!quiz || !quiz.questions) {
            console.log('Quiz not found:', quizId);
            return res.status(404).send('Quiz not found');
        }
        let score = 0;
        const feedback = quiz.questions.map((q, i) => {
            const isCorrect = answers[i].toLowerCase().trim() === q.correctAnswer.toLowerCase().trim();
            if (isCorrect) score++;
            return { prompt: q.prompt, correct: isCorrect, correctAnswer: q.correctAnswer };
        });
        const quizScore = Math.round((score / quiz.questions.length) * 100);

        const user = await User.findById(req.session.userId);
        if (!user.quizScores) user.quizScores = [];
        const existingScoreIndex = user.quizScores.findIndex(s => s.quizId.toString() === quizId);
        if (existingScoreIndex !== -1) {
            user.quizScores[existingScoreIndex].score = quizScore;
        } else {
            user.quizScores.push({ quizId, score: quizScore });
        }
        await recalculateUserScore(user);

        console.log('Quiz processed:', { quizId, quizScore, totalScore: user.score });
        res.json({ score: score, total: quiz.questions.length, feedback });
    } catch (err) {
        console.error('Quiz submission error:', err.message, err.stack);
        res.status(500).json({ error: `Server error: ${err.message}` });
    }
});

app.get('/logout', (req, res) => {
    console.log('Logout route hit');
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err.message, err.stack);
            return res.status(500).json({ error: `Logout failed: ${err.message}` });
        }
        console.log('Session destroyed, redirecting to /index.html');
        res.redirect('/index.html');
    });
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));