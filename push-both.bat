@echo off
echo Pushing to GitHub...
git push github main --force

echo Pushing to Hugging Face...
git push hf main --force

echo Done! Both repositories updated.
