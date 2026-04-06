-- MySQL Database Schema for Exam Management System
-- Database: omr_exam_system

-- 1. Teachers Table
CREATE TABLE IF NOT EXISTS teachers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Exams Table
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
);

-- 3. Answer Keys Table
CREATE TABLE IF NOT EXISTS answer_keys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    exam_id INT NOT NULL,
    question_number INT NOT NULL,
    correct_answer CHAR(1) NOT NULL,
    points DECIMAL(4,2) DEFAULT 5.00,
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
    UNIQUE KEY unique_exam_question (exam_id, question_number)
);

-- 4. Student Results Table
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
);

-- 5. Insert default teacher (password: teacher123)
INSERT INTO teachers (username, password, full_name) 
VALUES ('teacher', '$2b$10$YourHashedPasswordHere', 'Default Teacher')
ON DUPLICATE KEY UPDATE username = username;
