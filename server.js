const express = require('express');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const ExcelJS = require('exceljs');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

// MySQL Configuration
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: 'S19b310?',
    database: 'omr_exam_system',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session middleware
app.use(session({
    secret: 'omr-secret-key-2024',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

// Serve the model files correctly
app.use('/model', express.static(path.join(__dirname, 'model')));

// ========== DATABASE INITIALIZATION ==========
async function initDatabase() {
    try {
        const connection = await mysql.createConnection({
            host: dbConfig.host,
            user: dbConfig.user,
            password: dbConfig.password
        });
        
        await connection.query(`CREATE DATABASE IF NOT EXISTS ${dbConfig.database}`);
        await connection.end();
        
        const db = await pool.getConnection();
        
        // Create tables
        await db.query(`
            CREATE TABLE IF NOT EXISTS teachers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                full_name VARCHAR(100) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await db.query(`
            CREATE TABLE IF NOT EXISTS exams (
                id INT AUTO_INCREMENT PRIMARY KEY,
                teacher_id INT NOT NULL,
                exam_name VARCHAR(200) NOT NULL,
                exam_date DATE NOT NULL,
                question_count INT NOT NULL DEFAULT 20,
                correct_points DECIMAL(4,2) NOT NULL DEFAULT 5.00,
                wrong_points DECIMAL(4,2) DEFAULT 0.00,
                empty_points DECIMAL(4,2) DEFAULT 0.00,
                status ENUM('active', 'inactive', 'completed') DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
            )
        `);
        
        await db.query(`
            CREATE TABLE IF NOT EXISTS answer_keys (
                id INT AUTO_INCREMENT PRIMARY KEY,
                exam_id INT NOT NULL,
                question_number INT NOT NULL,
                correct_answer CHAR(1) NOT NULL,
                points DECIMAL(4,2) DEFAULT 5.00,
                FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
                UNIQUE KEY unique_exam_question (exam_id, question_number)
            )
        `);
        
        await db.query(`
            CREATE TABLE IF NOT EXISTS student_results (
                id INT AUTO_INCREMENT PRIMARY KEY,
                exam_id INT NOT NULL,
                student_number VARCHAR(20) NOT NULL,
                answers JSON NOT NULL,
                correct_count INT DEFAULT 0,
                wrong_count INT DEFAULT 0,
                empty_count INT DEFAULT 0,
                total_score DECIMAL(6,2) DEFAULT 0.00,
                scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
                UNIQUE KEY unique_exam_student (exam_id, student_number)
            )
        `);
        
        // Insert default teacher
        const hashedPassword = await bcrypt.hash('teacher123', 10);
        await db.query(`
            INSERT IGNORE INTO teachers (username, password, full_name) 
            VALUES ('teacher', ?, 'Default Teacher')
        `, [hashedPassword]);
        
        db.release();
        console.log('Database initialized successfully');
    } catch (error) {
        console.error('Database initialization error:', error);
    }
}

// ========== AUTHENTICATION ROUTES ==========

// Teacher Login
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const [teachers] = await pool.query('SELECT * FROM teachers WHERE username = ?', [username]);
        
        if (teachers.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        
        const teacher = teachers[0];
        const validPassword = await bcrypt.compare(password, teacher.password);
        
        if (!validPassword) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        
        req.session.teacherId = teacher.id;
        req.session.teacherName = teacher.full_name;
        
        res.json({ 
            success: true, 
            teacher: { id: teacher.id, username: teacher.username, fullName: teacher.full_name }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Check Auth Status
app.get('/api/auth/status', (req, res) => {
    if (req.session.teacherId) {
        res.json({ 
            authenticated: true, 
            teacher: { id: req.session.teacherId, name: req.session.teacherName }
        });
    } else {
        res.json({ authenticated: false });
    }
});

// Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// ========== EXAM ROUTES ==========

// Get All Exams
app.get('/api/exams', async (req, res) => {
    try {
        const [exams] = await pool.query(`
            SELECT e.*, t.full_name as teacher_name,
            (SELECT COUNT(*) FROM student_results WHERE exam_id = e.id) as student_count
            FROM exams e
            JOIN teachers t ON e.teacher_id = t.id
            ORDER BY e.created_at DESC
        `);
        res.json({ success: true, exams });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get Single Exam
app.get('/api/exams/:id', async (req, res) => {
    try {
        const [exams] = await pool.query('SELECT * FROM exams WHERE id = ?', [req.params.id]);
        if (exams.length === 0) {
            return res.status(404).json({ success: false, message: 'Exam not found' });
        }
        
        const [answerKeys] = await pool.query(
            'SELECT * FROM answer_keys WHERE exam_id = ? ORDER BY question_number', 
            [req.params.id]
        );
        
        res.json({ success: true, exam: exams[0], answerKeys });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Create Exam
app.post('/api/exams', async (req, res) => {
    try {
        const { examName, examDate, questionCount, correctPoints, wrongPoints, emptyPoints, teacherId } = req.body;
        
        const [result] = await pool.query(
            `INSERT INTO exams (teacher_id, exam_name, exam_date, question_count, correct_points, wrong_points, empty_points) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [teacherId || 1, examName, examDate, questionCount, correctPoints, wrongPoints, emptyPoints]
        );
        
        res.json({ success: true, examId: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update Exam
app.put('/api/exams/:id', async (req, res) => {
    try {
        const { examName, examDate, status } = req.body;
        await pool.query(
            'UPDATE exams SET exam_name = ?, exam_date = ?, status = ? WHERE id = ?',
            [examName, examDate, status, req.params.id]
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Delete Exam
app.delete('/api/exams/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM exams WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========== ANSWER KEY ROUTES ==========

// Save Answer Key
app.post('/api/exams/:id/answer-key', async (req, res) => {
    try {
        const { answers } = req.body;
        const examId = req.params.id;
        
        // Delete existing answer key
        await pool.query('DELETE FROM answer_keys WHERE exam_id = ?', [examId]);
        
        // Insert new answer key
        const values = answers.map(a => [examId, a.questionNumber, a.answer, a.points || 5]);
        await pool.query(
            'INSERT INTO answer_keys (exam_id, question_number, correct_answer, points) VALUES ?',
            [values]
        );
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get Answer Key
app.get('/api/exams/:id/answer-key', async (req, res) => {
    try {
        const [answerKeys] = await pool.query(
            'SELECT * FROM answer_keys WHERE exam_id = ? ORDER BY question_number',
            [req.params.id]
        );
        res.json({ success: true, answerKeys });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========== STUDENT RESULT ROUTES ==========

// Save Student Result
app.post('/api/exams/:id/results', async (req, res) => {
    try {
        const { studentNumber, answers, correctCount, wrongCount, emptyCount, totalScore } = req.body;
        const examId = req.params.id;
        
        // Check if result already exists
        const [existing] = await pool.query(
            'SELECT id FROM student_results WHERE exam_id = ? AND student_number = ?',
            [examId, studentNumber]
        );
        
        if (existing.length > 0) {
            // Update existing
            await pool.query(
                `UPDATE student_results 
                 SET answers = ?, correct_count = ?, wrong_count = ?, empty_count = ?, total_score = ?
                 WHERE exam_id = ? AND student_number = ?`,
                [JSON.stringify(answers), correctCount, wrongCount, emptyCount, totalScore, examId, studentNumber]
            );
        } else {
            // Insert new
            await pool.query(
                `INSERT INTO student_results (exam_id, student_number, answers, correct_count, wrong_count, empty_count, total_score)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [examId, studentNumber, JSON.stringify(answers), correctCount, wrongCount, emptyCount, totalScore]
            );
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get Exam Results
app.get('/api/exams/:id/results', async (req, res) => {
    try {
        const [results] = await pool.query(
            'SELECT * FROM student_results WHERE exam_id = ? ORDER BY total_score DESC',
            [req.params.id]
        );
        res.json({ success: true, results });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get Single Student Result
app.get('/api/exams/:examId/results/:studentNumber', async (req, res) => {
    try {
        const [results] = await pool.query(
            'SELECT * FROM student_results WHERE exam_id = ? AND student_number = ?',
            [req.params.examId, req.params.studentNumber]
        );
        
        if (results.length === 0) {
            return res.status(404).json({ success: false, message: 'Result not found' });
        }
        
        res.json({ success: true, result: results[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Delete Student Result
app.delete('/api/results/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM student_results WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========== EXCEL EXPORT ==========

// Export Results to Excel
app.get('/api/exams/:id/export', async (req, res) => {
    try {
        const [exam] = await pool.query('SELECT * FROM exams WHERE id = ?', [req.params.id]);
        if (exam.length === 0) {
            return res.status(404).json({ success: false, message: 'Exam not found' });
        }
        
        const [results] = await pool.query(
            'SELECT * FROM student_results WHERE exam_id = ? ORDER BY CAST(student_number AS UNSIGNED)',
            [req.params.id]
        );
        
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Sınav Sonuçları');
        
        // Title
        worksheet.mergeCells('A1:H1');
        worksheet.getCell('A1').value = exam[0].exam_name;
        worksheet.getCell('A1').font = { size: 16, bold: true };
        worksheet.getCell('A1').alignment = { horizontal: 'center' };
        
        // Headers
        worksheet.getRow(3).values = ['Öğrenci No', 'Doğru', 'Yanlış', 'Boş', 'Puan', 'Tarih'];
        worksheet.getRow(3).font = { bold: true };
        
        // Data
        results.forEach((result, index) => {
            worksheet.getRow(index + 4).values = [
                result.student_number,
                result.correct_count,
                result.wrong_count,
                result.empty_count,
                result.total_score,
                new Date(result.scanned_at).toLocaleDateString('tr-TR')
            ];
        });
        
        // Style
        worksheet.columns.forEach(column => {
            column.width = 15;
        });
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=sinav-sonuclari-${req.params.id}.xlsx`);
        
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Initialize database on startup
initDatabase();

app.listen(PORT, () => {
    console.log(`Server started on http://localhost:${PORT}`);
    console.log(`MySQL Database: ${dbConfig.database}`);
});
