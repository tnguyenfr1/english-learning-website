const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoDBStore = require('connect-mongodb-session')(session);
const bcrypt = require('bcrypt');
const stripe = require('stripe')('sk_test_51YourActualStripeSecretKey'); // Replace with your real key
const app = express();

app.use(express.json());
app.use(express.static('public'));

const mongoURI = 'mongodb+srv://admin:securepassword123@englishlearningcluster.bhzo4.mongodb.net/?retryWrites=true&w=majority&appName=EnglishLearningCluster'
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
    .catch(err => console.error('MongoDB connection error, proceeding without DB:', err));

// User Schema
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

// Login Endpoint
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
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
    }
});

// User Data Endpoint
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
        const data = {
            name: user.name,
            score: user.score || 49, // Fallback if DB fails
            homeworkScores: user.homeworkScores || [],
            pronunciationScores: user.pronunciationScores || [],
            comprehensionScores: user.comprehensionScores || [],
            quizScores: user.quizScores || [],
            referencesVisited: user.referencesVisited || [],
            achievements: user.achievements || [{ name: 'Pronunciation Pro', dateEarned: new Date() }]
        };
        console.log('User data sent:', data);
        res.json(data);
    } catch (err) {
        console.error('User data error:', err);
        res.status(500).json({ error: 'Server error - DB may be unavailable' });
    }
});

app.listen(3000, () => console.log('Server running on http://localhost:3000'));