document.addEventListener('DOMContentLoaded', function() {
  const extractBtn = document.getElementById('extractBtn');
  const results = document.getElementById('results');
  const emailList = document.getElementById('emailList');
  const count = document.getElementById('count');
  const noEmails = document.getElementById('noEmails');
  const copyBtn = document.getElementById('copyBtn');

  // Reset everything when extension opens
  function resetExtension() {
    extractBtn.disabled = false;
    extractBtn.textContent = 'Extract Sender Emails';
    results.style.display = 'none';
    noEmails.style.display = 'none';
    copyBtn.style.display = 'none';
    emailList.innerHTML = '';
    count.textContent = '';
    copyBtn.dataset.emails = '';
  }

  function resetButton() {
    extractBtn.disabled = false;
    extractBtn.textContent = 'Extract Sender Emails';
  }

  function showError(message) {
    noEmails.textContent = message;
    noEmails.style.display = 'block';
    resetButton();
  }

  // Initialize with clean state
  resetExtension();

  extractBtn.addEventListener('click', function() {
    // Disable button during extraction
    extractBtn.disabled = true;
    extractBtn.textContent = 'Extracting Senders...';
    
    // Hide previous results
    results.style.display = 'none';
    noEmails.style.display = 'none';
    copyBtn.style.display = 'none';
    
    // Get the active tab
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (chrome.runtime.lastError) {
        showError('Error getting active tab: ' + chrome.runtime.lastError.message);
        return;
      }
      
      const currentTab = tabs[0];
      if (!currentTab) {
        showError('No active tab found');
        return;
      }
      
      // Check if we can access the tab
      if (currentTab.url.startsWith('chrome://') || currentTab.url.startsWith('chrome-extension://')) {
        showError('Cannot extract emails from Chrome internal pages');
        return;
      }
      
      // Inject content script
      chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        files: ['content.js']
      }, function() {
        if (chrome.runtime.lastError) {
          console.error('Error injecting script:', chrome.runtime.lastError);
          showError('Error injecting script: ' + chrome.runtime.lastError.message);
          return;
        }
        
        // Wait a moment for the script to load, then send message
        setTimeout(function() {
          chrome.tabs.sendMessage(currentTab.id, {action: 'extractEmails'}, function(response) {
            resetButton();
            
            if (chrome.runtime.lastError) {
              console.error('Error sending message:', chrome.runtime.lastError);
              showError('Error communicating with page: ' + chrome.runtime.lastError.message);
              return;
            }
            
            if (response && response.emails) {
              const emails = response.emails;
              
              if (emails.length > 0) {
                // Check if the first email is an error message
                if (emails[0].includes('Not on Gmail') || emails[0].includes('Please navigate')) {
                  showError(emails[0]);
                  return;
                }
                
                // Display emails
                emailList.innerHTML = '';
                emails.forEach(email => {
                  const emailDiv = document.createElement('div');
                  emailDiv.className = 'email-item';
                  emailDiv.textContent = email;
                  emailList.appendChild(emailDiv);
                });
                
                count.textContent = `Found ${emails.length} sender email${emails.length === 1 ? '' : 's'}`;
                results.style.display = 'block';
                copyBtn.style.display = 'block';
                
                // Store emails for copying
                copyBtn.dataset.emails = emails.join('\n');
              } else {
                showError('No spam emails found in spam folder. The folder may be empty.');
              }
            } else {
              showError('No response from page. Try refreshing the page and try again.');
            }
          });
        }, 100); // Small delay to ensure script is loaded
      });
    });
  });

  // Copy button functionality
  copyBtn.addEventListener('click', function() {
    const emails = copyBtn.dataset.emails;
    if (emails) {
      navigator.clipboard.writeText(emails).then(function() {
        const originalText = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        copyBtn.style.backgroundColor = '#45a049';
        
        setTimeout(function() {
          copyBtn.textContent = originalText;
          copyBtn.style.backgroundColor = '#2196F3';
        }, 2000);
      }).catch(function(err) {
        console.error('Failed to copy emails:', err);
        alert('Failed to copy emails to clipboard');
      });
    }
  });
});
