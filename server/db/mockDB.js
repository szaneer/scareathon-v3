import dotenv from 'dotenv';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

export function buildProductionPoolConfig(env = process.env) {
  const rawConnectionString = env.DB_CONNECTION_STRING || '';
  let connectionString = rawConnectionString;

  if (!rawConnectionString) {
    throw new Error('Missing DB_CONNECTION_STRING for production database connection.');
  }

  try {
    const parsed = new URL(rawConnectionString);
    parsed.searchParams.delete('sslmode');

    if (env.DB_PASSWORD) {
      parsed.password = env.DB_PASSWORD;
    }

    connectionString = parsed.toString();
  } catch (_) {
    connectionString = rawConnectionString;
  }

  return {
    connectionString,
    ssl: {
      rejectUnauthorized: false
    }
  };
}

// Create a new pool
let pool = null;

if (process.env.DB_CONNECTION_STRING) {
  pool = new Pool(buildProductionPoolConfig());
} else {
  pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'scareathon',
    password: 'postgres',
    port: 5432,
  });
}

// An idle client can be dropped by the database or the pooler at any time.
// pg emits that on the pool, and an 'error' event with no listener throws and
// takes the whole server down, so log it instead; the pool replaces the client.
pool.on('error', (err) => {
  console.error(JSON.stringify({
    level: 'error',
    msg: 'Postgres pool: idle client error (client discarded)',
    err: { message: err.message, code: err.code, stack: err.stack },
    time: new Date().toISOString(),
  }));
});

// Function to initialize the database
async function _initializeDB() {
  const client = await pool.connect();
  try {
    // Read the SQL file
    const sqlFile = path.join(__dirname, 'db.sql');
    const sql = fs.readFileSync(sqlFile, 'utf8');

    // Execute the SQL
    await client.query(sql);
    console.log('Database initialized successfully');

    // Insert sample data (if needed)
    // await insertSampleData(client);
  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
    client.release();
  }
}

// Function to mock insert users with null usernames
async function _mockInsertNullUsers(count = 5) {
  const client = await pool.connect();
  const emails = ["test1@test.com", "test2@test.com", "test3@test.com", "test4@test.com", "test5@test.com"];
  try {
    for (let i = 0; i < count; i++) {
      const userId = uuidv4();
      const query = 'INSERT INTO users (id, username, email) VALUES ($1, $2, $3)';
      await client.query(query, [userId, null, emails[i]]);
    }
    console.log(`Successfully inserted ${count} users with null usernames`);
  } catch (err) {
    console.error('Error inserting mock users:', err);
  } finally {
    client.release();
  }
}

// if (process.env.NODE_ENV === 'development') {
// Initialize the database
// initializeDB();

// Mock insert users with null usernames
// mockInsertNullUsers();
// }

async function _addSpookyUsernames() {

  const spookyAdjectives = [
    'Ghostly', 'Haunted', 'Creepy', 'Spooky', 'Eerie', 'Shadowy', 'Cursed', 'Wicked', 
    'Sinister', 'Frightful', 'Macabre', 'Ominous', 'Grim', 'Morbid', 'Terrifying', 
    'Dreadful', 'Vile', 'Bloodcurdling', 'Ghastly', 'Menacing', 'Nightmarish', 
    'Mysterious', 'Horrifying', 'Chilling', 'Dark'
  ];
  
  const spookyNouns = [
    'Phantom', 'Skeleton', 'Wraith', 'Goblin', 'Ghoul', 'Specter', 'Banshee', 'Zombie', 
    'Vampire', 'Werewolf', 'Demon', 'Witch', 'Poltergeist', 'Shade', 'Beast', 
    'Nightstalker', 'Cryptkeeper', 'Mummy', 'Revenant', 'Warlock', 'Lich', 
    'Necromancer', 'Gorgon', 'Ogre', 'Troll'
  ];
  
  function generateSpookyUsername() {
    const adjective = spookyAdjectives[Math.floor(Math.random() * spookyAdjectives.length)];
    const noun = spookyNouns[Math.floor(Math.random() * spookyNouns.length)];
    const randomNum = Math.floor(Math.random() * 1000); // Keep the random number for uniqueness
    return `${adjective}${noun}${randomNum}`;
  }

  try {
    const users = await pool.query('SELECT id, email FROM users WHERE username IS NULL');

    for (let user of users.rows) {
      const spookyUsername = generateSpookyUsername();

      const { error: updateError } = await pool.query('UPDATE users SET username = $1 WHERE id = $2', [spookyUsername, user.id]);

      if (updateError) {
        console.error(`Error updating user ${user.email}:`, updateError);
      } else {
        console.log(`Updated ${user.email} with username ${spookyUsername}`);
      }
    }
  } catch (error) {
    console.error('Error adding spooky usernames:', error);
  }
}

// addSpookyUsernames();

// Export the pool for use in other files
export default pool;
