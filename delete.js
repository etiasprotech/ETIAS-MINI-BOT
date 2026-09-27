require('dotenv').config();
const mongoose = require('mongoose');
async function del(){
  await mongoose.connect(process.env.MONGODB_URI);
  const SessionModel = mongoose.model('Session', new mongoose.Schema({ userId: String }, {strict:false}), 'sessions');
  const id = process.argv[2]; // e.g. node delete.js 263778810589
  if(!id) return console.log("Usage: node delete.js 2637xxxx");
  const res = await SessionModel.deleteOne({ userId: id });
  console.log(`Deleted ${res.deletedCount} for ${id}`);
  const all = await SessionModel.find({});
  console.log(`Remaining: ${all.length}`, all.map(s=>s.userId));
  process.exit();
}
del();
