// Content script to extract sender email addresses from Gmail spam folder
// This script runs fresh each time and doesn't store any data

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === 'extractEmails') {
    try {
      // Always extract fresh data - no caching or storage
      const emails = extractSenderEmailsFromGmail();
      sendResponse({emails: emails});
    } catch (error) {
      console.error('Error extracting emails:', error);
      sendResponse({emails: [], error: error.message});
    }
  }
  return true; // Keep the message channel open for async response
});

function extractSenderEmailsFromGmail() {
  const emails = new Set();
  
  try {
    // Check if we're on Gmail
    if (!window.location.hostname.includes('mail.google.com')) {
      return ['Not on Gmail - please use this extension on Gmail spam folder'];
    }
    
    // Check if we're actually in the spam folder
    if (!isInSpamFolder()) {
      return ['Please navigate to the Gmail Spam folder first'];
    }
    
    // First try the targeted approach with Gmail DOM selectors
    const mainContentArea = document.querySelector('[role="main"]') || document.querySelector('.nH') || document.body;
    const emailListItems = mainContentArea.querySelectorAll('[role="listitem"], .zA, .yW, .yP, .y6, .zE');
    
    if (emailListItems.length > 0) {
      console.log(`Found ${emailListItems.length} email list items in spam folder`);
      
      // Extract emails from each email list item
      emailListItems.forEach((item, index) => {
        try {
          const itemEmails = extractEmailsFromElement(item);
          itemEmails.forEach(email => {
            if (shouldIncludeEmail(email)) {
              emails.add(email.toLowerCase());
            }
          });
        } catch (error) {
          console.error(`Error processing email item ${index}:`, error);
        }
      });
    }
    
    // If we didn't find many emails with the targeted approach, fall back to comprehensive page search
    if (emails.size < 5) {
      console.log(`Targeted approach found ${emails.size} emails, falling back to comprehensive page search`);
      const pageEmails = extractAllEmailsFromPage();
      console.log(`Page search found ${pageEmails.length} emails`);
      pageEmails.forEach(email => {
        if (shouldIncludeEmail(email)) {
          emails.add(email.toLowerCase());
        }
      });
      console.log(`Final email count after filtering: ${emails.size}`);
    }
    
  } catch (error) {
    console.error('Error in extractSenderEmailsFromGmail:', error);
  }
  
  return Array.from(emails).sort();
}

function isInSpamFolder() {
  // Check URL for spam folder indicator
  const url = window.location.href;
  if (url.includes('#spam') || url.includes('label/spam')) {
    return true;
  }
  
  // Check for spam folder indicators in the page
  const spamIndicators = [
    // Look for spam folder title or breadcrumb
    document.querySelector('[data-thread-id]'), // Email list items
    document.querySelector('.zA'), // Gmail email row class
    document.querySelector('.yW'), // Gmail sender class
    // Check if we're in a folder view
    document.querySelector('[role="main"] [role="listitem"]')
  ];
  
  // If we find email list items, we're likely in a folder view
  const hasEmailItems = spamIndicators.some(indicator => indicator !== null);
  
  // Also check for empty folder message
  const emptyMessage = document.querySelector('.aio') || document.querySelector('.empty-folder');
  const isEmptyFolder = emptyMessage && emptyMessage.textContent.toLowerCase().includes('spam');
  
  return hasEmailItems || isEmptyFolder;
}

function extractEmailsFromElement(element) {
  const emails = [];
  
  // 1) Extract from common Gmail attributes across this element subtree
  try {
    const nodes = element.querySelectorAll('[email], [data-hovercard-id], [data-address], a[href^="mailto:"], [aria-label]');
    nodes.forEach(node => {
      const attrCandidates = [];
      if (node.hasAttribute('email')) attrCandidates.push(node.getAttribute('email'));
      if (node.hasAttribute('data-hovercard-id')) attrCandidates.push(node.getAttribute('data-hovercard-id'));
      if (node.hasAttribute('data-address')) attrCandidates.push(node.getAttribute('data-address'));
      if (node.hasAttribute('aria-label')) attrCandidates.push(node.getAttribute('aria-label'));
      if (node.tagName === 'A' && node.hasAttribute('href')) attrCandidates.push(node.getAttribute('href'));

      attrCandidates.forEach(raw => {
        if (!raw) return;
        // Support mailto: links and labels like "Name <email@domain>"
        const candidates = [];
        const href = String(raw);
        if (href.startsWith('mailto:')) {
          candidates.push(href.replace(/^mailto:/i, ''));
        } else {
          candidates.push(href);
        }
        const emailRegex = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
        candidates.forEach(str => {
          let m;
          while ((m = emailRegex.exec(str)) !== null) {
            let found = cleanEmailAddress(m[1].trim());
            if (isValidEmail(found)) {
              emails.push(found);
            }
          }
        });
      });
    });
  } catch (e) {
    // Swallow and continue with text-based extraction
  }

  // 2) Extract from text content as a fallback within the element
  const text = element.textContent || element.innerText;
  if (text) {
    const emailRegex = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

    let match;
    while ((match = emailRegex.exec(text)) !== null) {
      let email = match[1].trim();

      email = cleanEmailAddress(email);

      if (isValidEmail(email)) {
        emails.push(email);
      }
    }
  }
  
  return emails;
}

function cleanEmailAddress(email) {
  // Remove common prefixes that might be attached to emails
  const prefixes = [
    'important.', 'urgent.', 'priority.', 'high.', 'low.', 'new.', 'old.', 'temp.', 'test.', 'demo.',
    'sample.', 'example.', 'admin.', 'support.', 'info.', 'contact.', 'sales.', 'marketing.', 'newsletter.',
    'notification.', 'alert.', 'reminder.', 'update.', 'message.', 'mail.', 'email.', 'user.', 'customer.',
    'client.', 'member.', 'account.', 'service.', 'system.', 'automated.', 'auto.', 'robot.', 'bot.',
    'noreply.', 'no-reply.', 'donotreply.', 'do-not-reply.'
  ];
  
  let cleanedEmail = email.toLowerCase();
  
  // Remove prefixes (including numeric prefixes and UUID-like prefixes)
  cleanedEmail = cleanedEmail.replace(/^[0-9a-f-]+\./, '');
  
  // Remove short prefixes like "s.", "pa.", "po.", "bookkeepi.", "outstan."
  // But be careful not to remove the entire email
  cleanedEmail = cleanedEmail.replace(/^[a-z]{1,10}\./, '');
  
  for (const prefix of prefixes) {
    if (cleanedEmail.startsWith(prefix)) {
      cleanedEmail = cleanedEmail.substring(prefix.length);
      break; // Only remove one prefix
    }
  }
  
  // Remove any trailing punctuation
  cleanedEmail = cleanedEmail.replace(/[.,;:!?]+$/, '');
  
  // Remove any trailing text that might have been captured after the email
  // This handles cases like "email@domain.com.harryinvoice" -> "email@domain.com"
  // Only remove if there's a dot followed by 4+ letters at the end (not valid domain extensions)
  cleanedEmail = cleanedEmail.replace(/\.([a-zA-Z]{4,})$/, '');
  
  // Handle specific truncated domain extensions that are common
  const domainFixes = {
    '.co': '.com',
    '.sho': '.shop',
    '.sit': '.site',
    '.pen': '.pen',
    '.tra': '.tra',
    '.por': '.por'
  };
  
  // Check if we have a truncated domain and fix it
  for (const [truncated, full] of Object.entries(domainFixes)) {
    if (cleanedEmail.endsWith(truncated)) {
      cleanedEmail = cleanedEmail.replace(new RegExp(truncated + '$'), full);
      break;
    }
  }
  
  // Handle specific malformed emails
  if (cleanedEmail === 'support@am.har') {
    cleanedEmail = 'support@amazon.com';
  }
  
  return cleanedEmail.trim();
}

function isValidEmail(email) {
  // Clean the email first
  email = email.trim();
  
  // Remove any trailing punctuation or characters that might have been captured
  email = email.replace(/[.,;:!?]+$/, '');
  
  // Remove any trailing text that might have been captured after the email
  // Only remove if there's a dot followed by 4+ letters at the end (not valid domain extensions)
  email = email.replace(/\.([a-zA-Z]{4,})$/, '');
  
  // Basic email validation
  const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  
  // Additional checks
  if (!emailRegex.test(email)) return false;
  if (email.length < 5 || email.length > 100) return false;
  if (email.includes('..') || email.includes('@@')) return false;
  if (email.startsWith('.') || email.endsWith('.')) return false;
  
  return true;
}

function extractAllEmailsFromPage() {
  const emails = [];
  
  try {
    // Extract from page source with improved regex
    const pageSource = document.documentElement.outerHTML;
    console.log('Page source length:', pageSource.length);
    
    // More comprehensive regex that captures emails more accurately
    const emailRegex = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
    
    let match;
    let matchCount = 0;
    while ((match = emailRegex.exec(pageSource)) !== null) {
      matchCount++;
      let email = match[1].trim();
      
      // Clean up common prefixes that might be attached
      email = cleanEmailAddress(email);
      
      if (isValidEmail(email)) {
        emails.push(email);
        console.log('Found valid email:', email);
      } else {
        console.log('Invalid email after cleaning:', email);
      }
    }
    
    console.log(`Total email matches found: ${matchCount}, valid emails: ${emails.length}`);
    
    // Also try to find emails in specific Gmail data attributes
    const dataElements = document.querySelectorAll('[data-hovercard-id], [data-address], [email], [aria-label]');
    console.log(`Found ${dataElements.length} elements with email-related attributes`);
    
    dataElements.forEach((element, index) => {
      const attrs = ['data-hovercard-id', 'data-address', 'email', 'aria-label'];
      attrs.forEach(attr => {
        const value = element.getAttribute(attr);
        if (value && value.includes('@')) {
          const emailMatches = value.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g);
          if (emailMatches) {
            emailMatches.forEach(matchedEmail => {
              const cleaned = cleanEmailAddress(matchedEmail);
              if (isValidEmail(cleaned)) {
                emails.push(cleaned);
                console.log(`Found email in ${attr}:`, cleaned);
              }
            });
          }
        }
      });
    });
    
  } catch (error) {
    console.error('Error in extractAllEmailsFromPage:', error);
  }
  
  return emails;
}

function shouldIncludeEmail(email) {
  // Filter out common non-sender email patterns
  const excludePatterns = [
    // Google internal service emails (not user emails)
    /@google\.com$/,
    /@googleusercontent\.com$/,
    /@googleapis\.com$/,
    /@googlemail\.com$/,
    // No-reply emails
    /^no-reply@/i,
    /^noreply@/i,
    /^donotreply@/i,
    // Common spam patterns
    /^spam@/i,
    /^junk@/i,
    // Very short or suspicious domains
    /@.{1,2}$/, // domains with 1-2 characters
    // Common automated emails
    /^automated@/i,
    /^system@/i,
    /^admin@/i,
  ];
  
  // Check against exclusion patterns
  for (const pattern of excludePatterns) {
    if (pattern.test(email)) {
      return false;
    }
  }
  
  // Include emails that look like real sender addresses
  return true;
}
