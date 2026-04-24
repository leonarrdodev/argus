import * as dotenv from 'dotenv';
import { startServer } from './server.js';

dotenv.config();

startServer(5000);