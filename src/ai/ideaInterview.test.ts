import { describe, expect, it } from 'vitest';

/** Mirrors how interview Q&A is packed for composeWorldBriefFromInterview. */
function packInterviewAnswers(
  questions: Array<{ id: string; question: string }>,
  answers: Record<string, string>
): Array<{ question: string; answer: string }> {
  return questions.map((q) => ({
    question: q.question.trim(),
    answer: (answers[q.id] ?? '').trim()
  })).filter((a) => a.question);
}

describe('idea interview packing', () => {
  it('keeps unanswered questions as empty answers for the composer', () => {
    const packed = packInterviewAnswers(
      [
        { id: 'who', question: 'Who are you?' },
        { id: 'pressure', question: 'What pressure opens?' }
      ],
      { who: 'A smuggler under a false name' }
    );
    expect(packed).toEqual([
      { question: 'Who are you?', answer: 'A smuggler under a false name' },
      { question: 'What pressure opens?', answer: '' }
    ]);
  });

  it('drops blank questions', () => {
    const packed = packInterviewAnswers(
      [{ id: 'x', question: '  ' }, { id: 'y', question: 'Where?' }],
      { y: 'The long room' }
    );
    expect(packed).toEqual([{ question: 'Where?', answer: 'The long room' }]);
  });
});
