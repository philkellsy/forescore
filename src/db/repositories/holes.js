'use strict';

async function findByCourse(db, courseId) {
  return db('holes').where({ course_id: courseId }).orderBy('hole_number');
}

// Replace entire hole list for a course atomically
async function replaceAll(db, courseId, holes) {
  return db.transaction(async (trx) => {
    await trx('holes').where({ course_id: courseId }).delete();
    const rows = await trx('holes')
      .insert(holes.map((h) => ({ ...h, course_id: courseId })))
      .returning('*');
    return rows;
  });
}

module.exports = { findByCourse, replaceAll };
