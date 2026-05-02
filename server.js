require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const { connectDB } = require('./lib/prisma');

const userRoutes = require('./routes/user.routes');
const authRoutes = require('./routes/auth.routes');
const healthRoutes = require('./routes/health.routes');
const serviceRoutes = require('./routes/service.routes');
const clientRoutes = require('./routes/client.routes');
const employeeRoutes = require('./routes/employee.routes');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Serve static files from public directory
app.use(express.static('public'));

app.get('/', (req, res) => {
	res.status(200).json({
		message: 'ProPackers API is running',
		version: '1.0.0',
	});
});

app.use('/api/users', userRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/employees', employeeRoutes);

app.use((req, res) => {
	res.status(404).json({
		message: `Route not found: ${req.method} ${req.originalUrl}`,
	});
});

app.use((err, req, res, next) => {
	console.error('Unhandled error:', err);
	res.status(500).json({
		message: 'Internal server error',
	});
});

const startServer = async () => {
	try {
		await connectDB();
		app.listen(PORT, () => {
			console.log(`Server running on http://localhost:${PORT}`);
		});
	} catch (error) {
		console.error('Failed to start server:', error.message);
		process.exit(1);
	}
};

startServer();
