// Login form submission (scoped to /index.html)
if (window.location.pathname === '/index.html' || window.location.pathname === '/') {
    document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        console.log('Submitting login:', { email });

        try {
            const response = await fetch('/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const responseText = await response.text();
            console.log('Login response:', { status: response.status, text: responseText });
            if (!response.ok) throw new Error(`Login failed: ${response.status} - ${responseText}`);
            console.log('Login successful, redirecting to dashboard');
            window.location.href = '/dashboard.html';
        } catch (err) {
            console.error('Login fetch error:', err.message);
            alert('Failed to log in: ' + err.message);
        }
    });
}

// Signup form submission (scoped to /signup.html)
if (window.location.pathname === '/signup.html') {
    document.getElementById('signupForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        const name = document.getElementById('name').value;
        console.log('Submitting signup:', { email, name });

        try {
            const response = await fetch('/signup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password, name })
            });
            const responseText = await response.text();
            console.log('Signup response:', { status: response.status, text: responseText });
            if (!response.ok) throw new Error(`Signup failed: ${response.status} - ${responseText}`);
            alert('Signup successful! Please log in.');
            window.location.href = '/index.html';
        } catch (err) {
            console.error('Signup fetch error:', err.message);
            alert('Failed to sign up: ' + err.message);
        }
    });
}

// Add lesson form submission (scoped to /add-lesson.html)
if (window.location.pathname === '/add-lesson.html') {
    document.getElementById('addLessonForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = document.getElementById('title').value;
        const content = document.getElementById('content').value;
        const comprehensionText = document.getElementById('comprehensionText').value;
        const comprehensionQuestions = Array.from(document.querySelectorAll('.comprehension-field')).map(field => ({
            question: field.querySelector('input[name="question"]').value,
            correctAnswer: field.querySelector('select[name="correctAnswer"]').value === 'true'
        }));
        const homework = Array.from(document.querySelectorAll('.homework-field')).map(field => {
            const options = field.querySelector('input[name="options"]').value.split(',').map(opt => opt.trim()).filter(opt => opt);
            return {
                question: field.querySelector('input[name="question"]').value,
                type: field.querySelector('select[name="type"]').value,
                correctAnswer: field.querySelector('input[name="correctAnswer"]').value,
                ...(options.length > 0 && { options })
            };
        });
        const pronunciation = Array.from(document.querySelectorAll('.pronunciation-field')).map(field => ({
            phrase: field.querySelector('input[name="phrase"]').value
        }));

        console.log('Submitting lesson:', { title, content, comprehension: { text: comprehensionText, questions: comprehensionQuestions }, homework, pronunciation });

        try {
            const response = await fetch('/lessons', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, content, comprehension: { text: comprehensionText, questions: comprehensionQuestions }, homework, pronunciation })
            });
            const responseText = await response.text();
            console.log('Add lesson response:', { status: response.status, text: responseText });
            if (!response.ok) throw new Error(`Failed to add lesson: ${response.status} - ${responseText}`);
            alert('Lesson added successfully!');
            document.getElementById('addLessonForm').reset();
            window.location.href = '/dashboard.html';
        } catch (err) {
            console.error('Add lesson fetch error:', err.message);
            alert('Failed to add lesson: ' + err.message);
        }
    });
}